"""Companion — Health report analysis (bolt-on, READ-ONLY).

Streams a plain-language reading of an uploaded lab report (PDF or photo),
cross-referenced against the user's last 20 remembered health searches.

TWO PROPERTIES DEFINE THIS MODULE. Both are easy to break by copying from the
chat path, so they are stated here rather than left to be inferred:

  1. NOTHING IS STORED. This route reads memory and never writes it. There is
     deliberately NO `finally: persist_turn(...)` block in analyze() — the chat
     route has one, and a copy-paste implementation inherits it silently. The
     UI shows a privacy badge promising nothing is stored; that badge is only
     true because this module never inserts a row and never embeds.

  2. NO CONTENT LOGGING, UNCONDITIONALLY. COMPANION_DEBUG is honoured on the
     chat path and prints user health text to CloudWatch. This module does NOT
     honour it — not gated, not optional. A debug dump of an uploaded blood
     panel would falsify the badge outright. Log counts and outcomes; never
     bytes, never extracted text, never the filename's contents.

Safety line (BackEnd_Reports.md §2, Rule 1): a *reading* may be called normal —
the lab already decided that and printed it, so restating it is transcription.
A *person* or an *organ* may never be called healthy; that is clinical judgement
and it is also where the model is most likely to be wrong. The rule lives in
prompts/report_analysis_prompt.md; this module just carries it there.
"""

import re
from datetime import datetime, timezone
from pathlib import Path

import psycopg2
from psycopg2.extras import RealDictCursor

import lambda_handler as core

# 3 MB DECODED. Base64 of 3 MB is ~4 MB, comfortably under the Lambda Function
# URL's 6 MB request-payload limit — that headroom is why the cap is 3, not 4.
# Enforced on the decoded length, server-side; the client is not trusted.
MAX_REPORT_BYTES = 3 * 1024 * 1024

RECENT_SEARCH_LIMIT = 20

# Exactly three accepted types -> (Bedrock block kind, Bedrock format string).
#
# `jpeg` is NOT `jpg`. Verified against the local botocore service model, not
# recalled: ImageFormat accepts png, jpeg, gif, webp — there is no "jpg", and
# mapping image/jpeg to "jpg" fails at the API. Do not "tidy" this.
MEDIA_TYPES = {
    "application/pdf": ("document", "pdf"),
    "image/png": ("image", "png"),
    "image/jpeg": ("image", "jpeg"),
}

# Magic bytes each declared type must actually start with. The client validates
# too, but the client is not trustworthy: a mislabelled file otherwise reaches
# Bedrock as the wrong block type.
MAGIC_BYTES = {
    "application/pdf": (b"%PDF",),
    "image/png": (b"\x89PNG",),
    "image/jpeg": (b"\xff\xd8\xff",),
}

PROMPT_PATH = Path(__file__).resolve().parent / "prompts" / "report_analysis_prompt.md"

_PROMPT_CACHE = None

# Lower than chat's 0.5: this is a reading task, not a conversational one.
TEMPERATURE = 0.3
MAX_TOKENS = 1500

FALLBACK_LINE = (
    "I'm having trouble reading that file right now. Nothing about it was "
    "stored — you're welcome to try again in a moment."
)

# AWS documents stricter naming rules for the document `name` field than the
# service model enforces (which bounds only length). A filename with underscores
# or unicode is a plausible request failure and there is no reason to risk it.
_NAME_ALLOWED = re.compile(r"[^A-Za-z0-9 \-]+")
_NAME_COLLAPSE = re.compile(r"\s+")


def load_report_prompt():
    global _PROMPT_CACHE
    if _PROMPT_CACHE is None:
        _PROMPT_CACHE = PROMPT_PATH.read_text(encoding="utf-8")
    return _PROMPT_CACHE


def render_report_prompt(template, recent_searches, current_datetime):
    """Inject context by replace(), never format(): the template contains
    markdown tables full of braces, and lab values can carry them too."""
    return (
        template.replace("{recent_searches}", recent_searches)
        .replace("{current_datetime}", current_datetime)
    )


def magic_bytes_agree(media_type, raw_bytes):
    """Does the file's leading signature match its declared media_type?"""
    prefixes = MAGIC_BYTES.get(media_type)
    if not prefixes:
        return False
    return any(raw_bytes.startswith(p) for p in prefixes)


def safe_document_name(name):
    """Alphanumerics, spaces and hyphens only; 1-200 chars; never empty."""
    cleaned = _NAME_ALLOWED.sub(" ", str(name or ""))
    cleaned = _NAME_COLLAPSE.sub(" ", cleaned).strip()
    if not cleaned:
        return "report"
    return cleaned[:200].strip() or "report"


def build_file_block(media_type, raw_bytes, name=None):
    """Bedrock Converse content block for the uploaded file.

    `raw_bytes` must be RAW BYTES — both ImageSource.bytes and
    DocumentSource.bytes take bytes, so base64 is decoded before it gets here.
    """
    kind, fmt = MEDIA_TYPES[media_type]
    if kind == "document":
        return {
            "document": {
                "format": fmt,
                "name": safe_document_name(name),
                "source": {"bytes": raw_bytes},
            }
        }
    return {"image": {"format": fmt, "source": {"bytes": raw_bytes}}}


def fetch_recent_searches(cur, user_token, limit=RECENT_SEARCH_LIMIT):
    """The user's last N remembered searches, newest first. READ-ONLY.

    Read from semantic_context_memory rather than patient_episodes: it holds the
    raw search text plus the classified theme and emotion, which is richer for
    this purpose.
    """
    cur.execute(
        """
        SELECT raw_interaction, emotional_state, theme, created_at
        FROM semantic_context_memory
        WHERE user_token = %s
        ORDER BY created_at DESC
        LIMIT %s
        """,
        (user_token, limit),
    )
    return cur.fetchall()


def format_recent_searches(rows, now=None):
    """One line per remembered search, stamped with an absolute date and a
    relative age so the model can say "three weeks ago" without doing date maths.

    An empty result is normal — a first-time user, or someone who set their own
    token — and must render as an explicit line, not an empty block, or the
    model is left guessing whether the memory lookup failed.
    """
    if not rows:
        return "No past searches on record for this person."
    now = now or datetime.now(timezone.utc)
    lines = []
    for r in rows:
        stamp = core._stamp(r.get("created_at"), now)
        theme = r.get("theme") or "unclassified"
        state = r.get("emotional_state") or "unknown"
        lines.append(f"- [{stamp}] ({theme}; felt: {state}) {r['raw_interaction']}")
    return "\n".join(lines)


def analyze(cfg, bedrock, user_token, file_spec):
    """Stream a plain-language reading of the report. SYNC generator.

    Starlette runs a sync generator in a threadpool, so iterating the
    synchronous Bedrock EventStream never blocks the event loop — the same
    reason the chat route's generator is sync.

    file_spec: {"media_type": str, "raw": bytes, "name": str}

    NOTE the absence of a `finally` persistence block. That is the deliberate
    difference from the chat route and the first thing a reviewer should check.
    """
    # Memory read happens up front and the connection is CLOSED before the model
    # call — never hold a CockroachDB connection open across streaming.
    searches_block = "No past searches on record for this person."
    try:
        conn = psycopg2.connect(core._normalize_dsn(cfg["database_url"]))
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                rows = fetch_recent_searches(cur, user_token)
            searches_block = format_recent_searches(rows, datetime.now(timezone.utc))
            print(f"[report] context: {len(rows)} remembered searches", flush=True)
        finally:
            conn.close()
    except Exception:  # noqa: BLE001 — a memory miss must not sink the reading
        core.traceback.print_exc()
        print("[report] context: memory lookup failed; continuing without it", flush=True)

    now = datetime.now(timezone.utc)
    system_prompt = render_report_prompt(
        load_report_prompt(),
        recent_searches=searches_block,
        current_datetime=now.strftime("%Y-%m-%d %H:%M UTC (%A)"),
    )

    messages = [
        {
            "role": "user",
            "content": [
                build_file_block(file_spec["media_type"], file_spec["raw"], file_spec.get("name")),
                {"text": "Here is my test report. Please read it back to me in plain language."},
            ],
        }
    ]

    streamed = False
    try:
        resp = bedrock.converse_stream(
            modelId=cfg["llm_model_id"],
            system=[{"text": system_prompt}],
            messages=messages,
            inferenceConfig={"maxTokens": MAX_TOKENS, "temperature": TEMPERATURE},
        )
        for event in resp["stream"]:
            block = event.get("contentBlockDelta")
            if block:
                delta = (block.get("delta") or {}).get("text", "")
                if delta:
                    streamed = True
                    yield delta
        print("[report] stream complete", flush=True)
    except Exception:  # noqa: BLE001
        core.traceback.print_exc()
        if not streamed:
            # Nothing reached the client yet — a calm line beats a dead panel.
            yield FALLBACK_LINE
        else:
            # Partial output is already on screen; stop cleanly rather than
            # appending an error to a half-read report.
            print("[report] stream failed after partial output", flush=True)
