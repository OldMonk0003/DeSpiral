"""Companion — Core Lambda handler (BackEnd Epic A4).

Hybrid memory pipeline for a single chat turn:
  1. Embed the user's prompt with Titan V2 (1024-dim).
  2. Retrieve semantic context (vector similarity) + recent episodes from
     CockroachDB, scoped to the user_token.
  3. Render the health-anxiety system prompt with that context.
  4. Generate an empathetic, non-diagnostic reply via Bedrock `converse`
     (Claude Sonnet 4.5).
  5. Persist the turn back to patient_episodes + semantic_context_memory.

Config is read lazily from the environment so a test harness can load a
.env before the first call. Expected vars: DATABASE_URL, AWS_REGION,
LLM_MODEL_ID, EMBEDDING_MODEL_ID, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY.
"""

import json
import os
import re
import traceback
from datetime import datetime, timezone
from pathlib import Path

import boto3
import psycopg2
from psycopg2.extras import RealDictCursor

# ---- constants ------------------------------------------------------------

EMBEDDING_DIM = 1024      # Titan V2 output dimensions
HISTORY_LIMIT = 5         # (legacy) recent episodes — no longer used in request path
SEMANTIC_LIMIT = 5        # nearest semantic memories pulled (long-term recall)
MAX_HISTORY_MSGS = 20     # cap on client transcript turns sent to the model

PROMPT_PATH = Path(__file__).resolve().parent / "prompts" / "health_anxiety_system_prompt.md"

_SYSTEM_PROMPT_CACHE = None

# Canonical turn-classification taxonomy (single source of truth — insights.py
# and both persist paths read these labels).
CLASSIFY_EMOTIONS = ["panic", "anxious", "worried", "uneasy"]
CLASSIFY_THEMES = ["Heart", "Liver & Gut", "Head & Nerves",
                   "Breathing & ENT", "Skin", "Lumps & Cancer", "General"]

CLASSIFY_SYSTEM_PROMPT = """You label a single health-related search query for an \
internal analytics dashboard. You are not talking to a person and you never \
diagnose, advise, or reassure — you only classify the text you are given.

Reply with ONLY a JSON object, no prose and no code fences:
{"theme": <one THEME>, "emotion": <one EMOTION>}

THEME — which part of the body the query is about:
  "Heart"           heart, chest, pulse, blood pressure, circulation
  "Liver & Gut"     liver, stomach, bowel, pancreas, kidney, digestion, blood-work enzymes
  "Head & Nerves"   head, brain, nerves, dizziness, tingling, vision, numbness
  "Breathing & ENT" lungs, breathing, cough, throat, nose, sinus, ears
  "Skin"            skin, rash, mole, hair, nails
  "Lumps & Cancer"  lumps, swollen nodes, masses, biopsies, cancer fears
  "General"         anything else — fatigue, fever, check-ups, or non-medical talk

EMOTION — how much distress the query carries. These come from someone
anxiously searching about their OWN health, so quiet concern is the floor, not
neutrality; terse and factual does not mean calm:
  "panic"   acute crisis language ("can't breathe", "am I dying", "emergency")
  "anxious" fearful or catastrophizing, urgent, jumping to the worst case
  "worried" concerned about their own symptom or test result — including short,
            factual lookups like "high blood pressure" or "elevated ALT meaning"
  "uneasy"  no personal stake — a general definition, someone else's condition,
            follow-up chit-chat, or text that isn't about health at all

Judge only the text provided. Output the JSON object and nothing else."""


# ---- config & clients -----------------------------------------------------

def _config():
    """Read runtime config from the environment on each invocation."""
    return {
        "database_url": os.environ.get("DATABASE_URL"),
        "aws_region": os.environ.get("AWS_REGION", "us-east-1"),
        "llm_model_id": os.environ.get("LLM_MODEL_ID", "anthropic.claude-sonnet-4-5"),
        "embedding_model_id": os.environ.get("EMBEDDING_MODEL_ID", "amazon.titan-embed-text-v2:0"),
        # Small/fast model for the Fix_6 yes-no intent check. Haiku 4.5 by
        # default — an order of magnitude cheaper than Sonnet for a one-word
        # answer, and the Lambda role's AmazonBedrockFullAccess already allows it.
        "intent_model_id": os.environ.get(
            "INTENT_MODEL_ID", "us.anthropic.claude-haiku-4-5-20251001-v1:0"
        ),
        # Fix_11 spend caps. Defaults exist so an unset/typo'd variable fails
        # SAFE (a low cap) rather than open (no cap).
        "max_calls": _int_env("MAX_CALLS", 100),               # chat, per UTC day
        "max_total_calls": _int_env("MAX_TOTAL_CALLS", 1000),   # chat, lifetime
        # /intent has its OWN budget (Fix_13). It is ~100x cheaper per call
        # (~$0.0002 vs ~$0.02) and, now that Google sends every Tier-1 miss,
        # far more frequent — metering it 1:1 against chat would let browsing
        # noise starve the budget the demo actually needs. 5000 lifetime intent
        # calls is about $1.
        "max_intent_calls": _int_env("MAX_INTENT_CALLS", 500),
        "max_intent_total_calls": _int_env("MAX_INTENT_TOTAL_CALLS", 5000),
        # /report has its own budget too, for the same reason but in the other
        # direction: it is the MOST expensive call in the product (image or PDF
        # tokens + 20 searches of context + a long output), so its counts are
        # deliberately smaller. 300 lifetime report calls is about $18.
        "max_report_calls": _int_env("MAX_REPORT_CALLS", 50),
        "max_report_total_calls": _int_env("MAX_REPORT_TOTAL_CALLS", 300),
    }


def _int_env(name, default):
    """Read a positive int from the environment, falling back to `default`.
    A malformed value must not 500 every request — it degrades to the default."""
    raw = os.environ.get(name)
    if raw is None or str(raw).strip() == "":
        return default
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        print(f"[config] {name}={raw!r} is not an integer; using {default}", flush=True)
        return default
    if value <= 0:
        print(f"[config] {name}={value} is not positive; using {default}", flush=True)
        return default
    return value


def _resolve_ca_bundle():
    """Locate a usable CA bundle. Prefer certifi (bundled in the deployment
    package) so TLS verification works regardless of the host's OpenSSL paths;
    fall back to common Linux system locations."""
    try:
        import certifi

        return certifi.where()
    except Exception:  # noqa: BLE001
        for path in (
            "/etc/pki/tls/certs/ca-bundle.crt",       # Amazon Linux / RHEL
            "/etc/ssl/certs/ca-certificates.crt",     # Debian / Ubuntu
        ):
            if os.path.exists(path):
                return path
    return None


def _normalize_dsn(url):
    """Point sslrootcert at a concrete CA bundle when TLS verification is on.

    CockroachDB Cloud uses publicly-trusted (Let's Encrypt) certs, but the
    bundled libpq/OpenSSL's default cert path is empty on Lambda, so
    `sslmode=verify-full` (with or without `sslrootcert=system`) fails. We
    rewrite it to certifi's bundle, which includes the required roots."""
    if not url:
        return url
    if "sslmode=verify-full" not in url and "sslmode=verify-ca" not in url:
        return url
    ca = _resolve_ca_bundle()
    if not ca:
        return url
    if "sslrootcert=" in url:
        return re.sub(r"sslrootcert=[^&]*", "sslrootcert=" + ca, url)
    sep = "&" if "?" in url else "?"
    return url + sep + "sslrootcert=" + ca


def _bedrock_client(region):
    # boto3 automatically reads AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from
    # the environment; region is passed explicitly.
    return boto3.client("bedrock-runtime", region_name=region)


def load_system_prompt():
    global _SYSTEM_PROMPT_CACHE
    if _SYSTEM_PROMPT_CACHE is None:
        _SYSTEM_PROMPT_CACHE = PROMPT_PATH.read_text(encoding="utf-8")
    return _SYSTEM_PROMPT_CACHE


# ---- Bedrock: embeddings + generation -------------------------------------

def generate_embedding(bedrock, model_id, text):
    """Return a 1024-dim, normalized Titan V2 embedding for `text`."""
    body = json.dumps({"inputText": text, "dimensions": EMBEDDING_DIM, "normalize": True})
    resp = bedrock.invoke_model(
        modelId=model_id,
        body=body,
        accept="application/json",
        contentType="application/json",
    )
    payload = json.loads(resp["body"].read())
    return payload["embedding"]


def invoke_llm(bedrock, model_id, system_prompt, messages):
    """Generate a reply via the Bedrock Converse API from a native messages[]."""
    resp = bedrock.converse(
        modelId=model_id,
        system=[{"text": system_prompt}],
        messages=messages,
        inferenceConfig={"maxTokens": 1024, "temperature": 0.5},
    )
    return resp["output"]["message"]["content"][0]["text"]


# ---- helpers --------------------------------------------------------------

def to_vector_literal(vec):
    """Format a float list as a CockroachDB VECTOR literal: '[0.1,0.2,...]'."""
    return "[" + ",".join(f"{x:.8f}" for x in vec) + "]"


def analyze_emotion(text):
    """Lightweight emotional-state label persisted with the semantic record."""
    t = (text or "").lower()
    if any(w in t for w in ("panic", "can't breathe", "cant breathe", "dying", "terrified", "emergency")):
        return "panic"
    if any(w in t for w in ("scared", "afraid", "fear", "chest", "heart", "racing")):
        return "anxious"
    if any(w in t for w in ("worried", "nervous", "concerned", "stress", "anxious")):
        return "worried"
    return "uneasy"


def _extract_json_object(text):
    """Return the first balanced {...} object parsed out of a model reply, or
    None. Models occasionally wrap JSON in prose or code fences, so we scan for
    the object rather than json.loads()-ing the whole reply."""
    if not text:
        return None
    start = text.find("{")
    if start == -1:
        return None
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                try:
                    parsed = json.loads(text[start:i + 1])
                except ValueError:
                    return None
                return parsed if isinstance(parsed, dict) else None
    return None


def classify_turn(bedrock, model_id, user_prompt):
    """Label a turn as {"emotion": ..., "theme": ...} with one small Bedrock
    call (temperature 0, tiny maxTokens).

    Replaces keyword guessing: terse factual queries ("high blood pressure")
    used to collapse to `uneasy`/`Other`. Called at PERSIST time only — after
    the stream has finished — so it never affects first-byte latency.

    Any failure (Bedrock error, malformed JSON, off-taxonomy label) degrades to
    the analyze_emotion() heuristic with theme=None; the turn is never lost.
    """
    fallback = {"emotion": analyze_emotion(user_prompt), "theme": None}
    if not user_prompt:
        return fallback
    try:
        resp = bedrock.converse(
            modelId=model_id,
            system=[{"text": CLASSIFY_SYSTEM_PROMPT}],
            messages=[{"role": "user", "content": [{"text": user_prompt}]}],
            inferenceConfig={"maxTokens": 60, "temperature": 0},
        )
        reply = resp["output"]["message"]["content"][0]["text"]
        parsed = _extract_json_object(reply) or {}
        emotion = parsed.get("emotion")
        theme = parsed.get("theme")
        return {
            "emotion": emotion if emotion in CLASSIFY_EMOTIONS else fallback["emotion"],
            "theme": theme if theme in CLASSIFY_THEMES else None,
        }
    except Exception:  # noqa: BLE001 — classification is best-effort metadata
        traceback.print_exc()
        return fallback


def render_prompt(template, page_context, semantic_memory,
                  distress_signal="", current_datetime=""):
    """Inject dynamic context. Uses replace() (not format()) so stray braces
    in the template or the injected content can never break rendering.
    The live conversation now rides in messages[], not the system prompt."""
    return (
        template.replace("{page_context}", page_context)
        .replace("{semantic_memory}", semantic_memory)
        .replace("{distress_signal}", distress_signal)
        .replace("{current_datetime}", current_datetime)
    )


def build_messages(history, user_prompt, max_msgs=MAX_HISTORY_MSGS):
    """Build a native Bedrock Converse messages[] from the client's session
    transcript plus the current turn. Guarantees the sequence alternates
    user/assistant, starts with a user turn, and ends with the current one."""
    msgs = []
    for h in (history or []):
        role = h.get("role")
        text = h.get("text")
        if role in ("user", "assistant") and text:
            msgs.append({"role": role, "content": [{"text": str(text)}]})

    if len(msgs) > max_msgs:
        msgs = msgs[-max_msgs:]

    # Bedrock requires the first message to be a user turn.
    while msgs and msgs[0]["role"] != "user":
        msgs.pop(0)

    # Bedrock requires strict user/assistant alternation — merge any accidental
    # consecutive same-role turns.
    coalesced = []
    for m in msgs:
        if coalesced and coalesced[-1]["role"] == m["role"]:
            coalesced[-1]["content"][0]["text"] += "\n" + m["content"][0]["text"]
        else:
            coalesced.append(m)

    # Append the current user turn (merge if the transcript already ends on user).
    if coalesced and coalesced[-1]["role"] == "user":
        coalesced[-1]["content"][0]["text"] += "\n" + user_prompt
    else:
        coalesced.append({"role": "user", "content": [{"text": user_prompt}]})
    return coalesced


def dedup_semantic(rows, history):
    """Drop semantic rows that merely echo turns already present in messages[]
    (this session), so long-term recall stays focused on prior sessions."""
    user_texts = {
        (h.get("text") or "").strip()
        for h in (history or [])
        if h.get("role") == "user"
    }
    if not user_texts:
        return rows
    return [r for r in rows if (r.get("raw_interaction") or "").strip() not in user_texts]


def humanize_age(ts, now):
    """Timezone-agnostic relative age of a timestamp, e.g. '~3 days ago'.
    LLMs are unreliable at date math, so we hand them the delta directly."""
    if ts is None:
        return "unknown time"
    secs = (now - ts).total_seconds()
    if secs < 120:
        return "just now"
    mins = secs / 60
    if mins < 60:
        return f"~{round(mins)} minutes ago"
    hours = mins / 60
    if hours < 24:
        return f"~{round(hours)} hours ago"
    days = hours / 24
    if days < 14:
        return f"~{round(days)} days ago"
    weeks = days / 7
    if weeks < 8:
        return f"~{round(weeks)} weeks ago"
    months = days / 30.44
    if months < 24:
        return f"~{round(months)} months ago"
    return f"~{round(days / 365.25)} years ago"


def _stamp(ts, now):
    """'2026-05-15 · ~10 weeks ago' — absolute date + relative age."""
    if ts is None:
        return "unknown time"
    return f"{ts.strftime('%Y-%m-%d')} · {humanize_age(ts, now)}"


def build_distress_signal(user_prompt, semantic_rows, history):
    """Compact, factual state read the model uses to pick grounding vs.
    informational tone (Adaptive Response Mode). Calibration only — the prompt
    instructs the model never to quote or count this back at the user."""
    emotion = analyze_emotion(user_prompt)
    turns = sum(1 for h in (history or []) if h.get("role") == "user")
    related = len(semantic_rows or [])
    parts = [f"Detected emotional tone: {emotion}."]
    if turns >= 3:
        parts.append(f"Part of an extended session ({turns} recent turns).")
    elif turns > 0:
        parts.append(f"{turns} recent turn(s) on record.")
    else:
        parts.append("First turn in this session.")
    if related:
        parts.append("Related past worries exist in memory (recurring theme likely).")
    parts.append(
        "Use only to calibrate tone (grounding-first vs. informational); "
        "never shame or count searches at the user."
    )
    return " ".join(parts)


def format_semantic_memory(rows, now=None):
    if not rows:
        return "No relevant past context found for this user yet."
    now = now or datetime.now(timezone.utc)
    lines = []
    for r in rows:
        state = r.get("emotional_state") or "unknown"
        stamp = _stamp(r.get("created_at"), now)
        lines.append(f"- [{stamp}] (past emotional state: {state}) {r['raw_interaction']}")
    return "\n".join(lines)


def format_conversation_history(rows, now=None):
    if not rows:
        return "No prior conversation on record."
    now = now or datetime.now(timezone.utc)
    # rows come newest-first; present oldest-first for natural reading.
    lines = []
    for r in reversed(rows):
        stamp = _stamp(r.get("recorded_at"), now)
        lines.append(f"[{stamp}]\nUser: {r['user_prompt']}\nAssistant: {r['ai_response']}")
    return "\n\n".join(lines)


def parse_event(event):
    """Accept either a raw payload dict or an API Gateway event (JSON body)."""
    if not isinstance(event, dict):
        event = {}
    body = event
    if event.get("body") is not None:
        raw = event["body"]
        if isinstance(raw, str):
            try:
                body = json.loads(raw)
            except (ValueError, TypeError):
                body = {}
        elif isinstance(raw, dict):
            body = raw
    history = body.get("history")
    return {
        "user_token": body.get("user_token"),
        "user_prompt": body.get("user_prompt", "") or "",
        "page_context": body.get("page_context", "") or "",
        "anxiety_tier": body.get("anxiety_tier", "severe") or "severe",
        "communication_style": body.get("communication_style", "gentle_soft") or "gentle_soft",
        "history": history if isinstance(history, list) else [],
        "session_started_at": body.get("session_started_at"),
    }


def _response(status, body_dict):
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
        "body": json.dumps(body_dict),
    }


# ---- DB retrieval ---------------------------------------------------------

def fetch_semantic_context(cur, user_token, vec_literal, limit=SEMANTIC_LIMIT):
    cur.execute(
        """
        SELECT raw_interaction, emotional_state, created_at,
               embedding <-> %s::VECTOR AS distance
        FROM semantic_context_memory
        WHERE user_token = %s
        ORDER BY embedding <-> %s::VECTOR
        LIMIT %s
        """,
        (vec_literal, user_token, vec_literal, limit),
    )
    return cur.fetchall()


# ---- spend quota (Fix_11) -------------------------------------------------

# One statement enforces BOTH caps and the daily rollover. The rollover clause
# `day <> current_date() OR calls_today < max_daily` is load-bearing: it lets
# the first request of a new day through even when yesterday ended at the cap,
# and the CASE then resets calls_today to 1. Drop that half and the counter jams
# permanently on the first day it fills.
#
# Do NOT rewrite this as SELECT-then-UPDATE. Those are two operations, and
# between them other requests act on the value read. On CockroachDB
# (serializable) that surfaces as 40001 retry errors under load — i.e. it breaks
# exactly when the cap matters.
_CLAIM_QUOTA_SQL = """
UPDATE api_usage
SET day = current_date(),
    calls_today = CASE WHEN day = current_date() THEN calls_today + 1 ELSE 1 END,
    calls_total = calls_total + 1,
    updated_at = now()
WHERE id = %(bucket)s
  AND calls_total < %(max_total)s
  AND (day <> current_date() OR calls_today < %(max_daily)s)
RETURNING calls_today, calls_total
"""


# Budget buckets — one ROW each, not extra columns. Each row carries its own
# `day`, so the daily rollover stays independent; sharing one `day` column would
# force whichever statement rolled the date to also reset the other bucket's
# counter, or yesterday's total would linger and wrongly reject today.
BUCKET_CHAT = 1
BUCKET_INTENT = 2
BUCKET_REPORT = 3


def claim_quota(cur, max_daily, max_total, bucket=BUCKET_CHAT):
    """Atomically claim one API call against a bucket's daily and lifetime caps.

    Returns (calls_today, calls_total) when the call is allowed, or None when
    either cap is exhausted. The caller must COMMIT promptly — every request
    contends on that bucket's single row, so holding the transaction open across
    a network call would serialise the whole service on it.
    """
    cur.execute(_CLAIM_QUOTA_SQL,
                {"max_daily": max_daily, "max_total": max_total, "bucket": bucket})
    row = cur.fetchone()
    if row is None:
        return None
    return row["calls_today"], row["calls_total"]


def read_quota(cur, bucket=BUCKET_CHAT):
    """Current counters for a bucket, for logging on the rejection path only."""
    cur.execute("SELECT day, calls_today, calls_total FROM api_usage WHERE id = %s",
                (bucket,))
    return cur.fetchone()


def fetch_recent_episodes(cur, user_token, limit=HISTORY_LIMIT):
    cur.execute(
        """
        SELECT user_prompt, ai_response, recorded_at
        FROM patient_episodes
        WHERE user_token = %s
        ORDER BY recorded_at DESC
        LIMIT %s
        """,
        (user_token, limit),
    )
    return cur.fetchall()


# ---- handler --------------------------------------------------------------

def lambda_handler(event, context):
    try:
        cfg = _config()
        data = parse_event(event)
        user_token = data["user_token"]
        user_prompt = data["user_prompt"]

        if not user_token or not user_prompt:
            return _response(400, {"error": "user_token and user_prompt are required"})
        if not cfg["database_url"]:
            return _response(500, {"error": "DATABASE_URL is not configured"})

        bedrock = _bedrock_client(cfg["aws_region"])

        # 1. Embed the prompt (1024-dim Titan V2).
        embedding = generate_embedding(bedrock, cfg["embedding_model_id"], user_prompt)
        vec_literal = to_vector_literal(embedding)

        conn = psycopg2.connect(_normalize_dsn(cfg["database_url"]))
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                # Ensure the profile row exists so the FK inserts below succeed.
                cur.execute(
                    """
                    INSERT INTO user_profiles (user_token, anxiety_tier, communication_style)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (user_token) DO NOTHING
                    """,
                    (user_token, data["anxiety_tier"], data["communication_style"]),
                )

                # 2. Long-term semantic recall (replaced each turn), de-duped
                #    against the current session's transcript.
                semantic_rows = dedup_semantic(
                    fetch_semantic_context(cur, user_token, vec_literal), data["history"]
                )

                # 3. Render the system prompt (instructions + long-term memory);
                #    the live conversation rides in messages[], not here.
                now = datetime.now(timezone.utc)
                system_prompt = render_prompt(
                    load_system_prompt(),
                    page_context=data["page_context"] or "No active page context.",
                    semantic_memory=format_semantic_memory(semantic_rows, now),
                    distress_signal=build_distress_signal(user_prompt, semantic_rows, data["history"]),
                    current_datetime=now.strftime("%Y-%m-%d %H:%M UTC (%A)"),
                )

                # 4. Generate the empathetic reply from native messages[].
                messages = build_messages(data["history"], user_prompt)
                ai_response = invoke_llm(bedrock, cfg["llm_model_id"], system_prompt, messages)

                # 4b. Classify the turn (theme + emotion) after generation, so
                #     the extra call never sits in front of the user's reply.
                label = classify_turn(bedrock, cfg["llm_model_id"], user_prompt)

                # 5. Persist the turn (episodic + semantic).
                cur.execute(
                    """
                    INSERT INTO patient_episodes (user_token, user_prompt, ai_response)
                    VALUES (%s, %s, %s)
                    RETURNING id
                    """,
                    (user_token, user_prompt, ai_response),
                )
                episode_id = cur.fetchone()["id"]

                cur.execute(
                    """
                    INSERT INTO semantic_context_memory
                        (user_token, episode_id, raw_interaction, emotional_state,
                         theme, embedding)
                    VALUES (%s, %s, %s, %s, %s, %s::VECTOR)
                    """,
                    (user_token, episode_id, user_prompt,
                     label["emotion"], label["theme"], vec_literal),
                )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

        return _response(200, {"ai_response": ai_response, "episode_id": str(episode_id)})

    except Exception as exc:  # noqa: BLE001 — surface any failure as a 500
        traceback.print_exc()
        return _response(500, {"error": str(exc)})
