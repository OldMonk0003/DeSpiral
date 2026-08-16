"""Companion — FastAPI streaming app (FrontEnd Epic A5, backend half).

Runs behind the AWS Lambda Web Adapter (uvicorn on 0.0.0.0:$PORT). Streams the
assistant's reply token-by-token via Bedrock `converse_stream`, then persists
the completed turn to CockroachDB.

Reuses the pure helpers from lambda_handler.py (embedding, retrieval, prompt
rendering, DSN TLS fix). The buffered lambda_handler() remains intact for local
tests and as a rollback path.

  GET  /   readiness probe (LWA default check path)
  POST /   streaming chat turn (text/plain deltas)
"""

import base64
import binascii
import os
import time
from datetime import datetime, timezone

import psycopg2
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from psycopg2.extras import RealDictCursor

import insights
import intent
import lambda_handler as core
import reports

app = FastAPI(title="Companion")


def _debug_enabled():
    """Temporary debug switch — set the Lambda env var COMPANION_DEBUG=1 to
    stream prompt-formation details to CloudWatch. Off by default."""
    return os.environ.get("COMPANION_DEBUG", "").strip().lower() in ("1", "true", "yes", "on")


def _debug_dump(user_token, data, semantic_rows, system_prompt, messages, model_id):
    """Print the assembled system prompt AND the native messages[] to stdout
    (-> CloudWatch). Guarded by _debug_enabled(); wrapped so it can never break
    a request. NOTE: emits user health-query text — enable only while debugging."""
    try:
        line = "=" * 70
        print(line, flush=True)
        print(f"[COMPANION DEBUG] turn | user_token={user_token} | model_id={model_id}", flush=True)
        print(f"[COMPANION DEBUG] user_prompt={data['user_prompt']!r}", flush=True)
        print(f"[COMPANION DEBUG] page_context={data['page_context']!r}", flush=True)
        print(f"[COMPANION DEBUG] anxiety_tier={data['anxiety_tier']} "
              f"communication_style={data['communication_style']}", flush=True)
        print(f"[COMPANION DEBUG] semantic_rows={len(semantic_rows)} "
              f"history_turns={len(data.get('history') or [])}", flush=True)
        print("[COMPANION DEBUG] ----- FULL SYSTEM PROMPT BELOW -----", flush=True)
        print(system_prompt, flush=True)
        print("[COMPANION DEBUG] ----- MESSAGES ARRAY -----", flush=True)
        for m in messages:
            text = (m.get("content") or [{}])[0].get("text", "")
            snippet = text if len(text) <= 300 else text[:300] + "…"
            print(f"[COMPANION DEBUG]   {m.get('role')}: {snippet!r}", flush=True)
        print(line, flush=True)
    except Exception:  # noqa: BLE001 — debug logging must never break a request
        core.traceback.print_exc()


@app.get("/")
def health():
    return {"status": "ok"}


# ---- spend quota (Fix_11) -------------------------------------------------
# The endpoint is public and unauthenticated for ~30 unattended days of judging.
# Every LLM-spending route claims one unit against a shared daily + lifetime cap
# BEFORE any Bedrock call. Failure to claim = 429, no model invocation.

QUOTA_MESSAGE = "Daily cap on Bedrock usage hit."
_QUOTA_BLOCK_TTL_S = 60

# Per-container memory of "this bucket's cap is spent". Rejected requests would
# otherwise still cost a CockroachDB write each, which over days of abuse can
# exceed the LLM spend being prevented. The short TTL means a manual counter
# reset takes effect in ~a minute rather than waiting for container recycling.
#
# Keyed BY BUCKET (Fix_13). A single global here would let an exhausted intent
# budget short-circuit chat as well — reintroducing in memory exactly the
# starvation that separate buckets remove from SQL.
_quota_blocked_until = {}


def _quota_short_circuited(bucket):
    return time.monotonic() < _quota_blocked_until.get(bucket, 0.0)


def _remember_quota_exhausted(bucket):
    _quota_blocked_until[bucket] = time.monotonic() + _QUOTA_BLOCK_TTL_S


def _quota_response():
    return JSONResponse({"error": QUOTA_MESSAGE}, status_code=429)


def _caps_for(cfg, bucket):
    """(daily, lifetime) caps for a bucket. Each route is metered separately so
    a cheap-but-frequent path and an expensive-but-rare one cannot starve each
    other: /intent is ~100x cheaper per call and far more frequent than chat,
    while /report is several times more expensive and deliberately capped low."""
    if bucket == core.BUCKET_INTENT:
        return cfg["max_intent_calls"], cfg["max_intent_total_calls"]
    if bucket == core.BUCKET_REPORT:
        return cfg["max_report_calls"], cfg["max_report_total_calls"]
    return cfg["max_calls"], cfg["max_total_calls"]


def claim_call_on(conn, cfg, bucket=None):
    """Claim one unit of a bucket's budget on an EXISTING connection.

    Used by the chat route, which is about to open a connection anyway — a
    second connection would mean a second TLS handshake to CockroachDB Cloud on
    the pre-stream path, which is exactly the first-byte cost this project's
    streaming design exists to avoid.
    """
    bucket = core.BUCKET_CHAT if bucket is None else bucket
    max_daily, max_total = _caps_for(cfg, bucket)
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        claim = core.claim_quota(cur, max_daily, max_total, bucket)
    # Commit immediately: every request contends on that bucket's row, so the
    # lock must not be held across the Bedrock calls that follow.
    conn.commit()
    if claim is not None:
        return True
    _remember_quota_exhausted(bucket)
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            print(f"[quota] rejected bucket={bucket} — {dict(core.read_quota(cur, bucket))} "
                  f"(caps {max_daily}/day, {max_total} total)", flush=True)
    except Exception:  # noqa: BLE001 — logging must not change the outcome
        pass
    return False


def claim_call(cfg, bucket=None):
    """Claim one unit of a bucket's budget, opening a connection to do it.

    For routes with no other DB work (/intent). Returns True when the caller may
    proceed to Bedrock. Fails CLOSED: any error — DB unreachable, malformed row
    — returns False rather than letting spend through ungated.
    """
    bucket = core.BUCKET_CHAT if bucket is None else bucket
    if _quota_short_circuited(bucket):
        return False
    try:
        conn = psycopg2.connect(core._normalize_dsn(cfg["database_url"]))
        try:
            return claim_call_on(conn, cfg, bucket)
        finally:
            conn.close()
    except Exception:  # noqa: BLE001 — fail closed, never spend on an error
        core.traceback.print_exc()
        return False


@app.post("/insights")
async def insights_route(request: Request):
    """Read-only Patterns & Insights snapshot (bolt-on; separate from chat)."""
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"error": "invalid JSON body"}, status_code=400)
    user_token = (body or {}).get("user_token")
    if not user_token:
        return JSONResponse({"error": "user_token is required"}, status_code=400)
    cfg = core._config()
    if not cfg["database_url"]:
        return JSONResponse({"error": "DATABASE_URL is not configured"}, status_code=500)
    # Viewer's UTC offset in minutes, so time-of-day buckets and day boundaries
    # read local rather than UTC (Fix_15). compute() clamps it — one owner for
    # that rule, so this stays a thin pass-through and cannot 500 on a hostile
    # value. Absent => 0 => the pre-Fix_15 UTC behaviour.
    tz_offset = (body or {}).get("tz_offset_minutes", 0)
    return JSONResponse(insights.compute(cfg, user_token, tz_offset))


@app.post("/intent")
async def intent_route(request: Request):
    """Yes/no medical-intent check for queries that missed the extension's
    Tier-1 filter (Fix_6 bolt-on; no DB, no memory, nothing persisted).

    Never returns 5xx: on any failure it answers {"medical": false} so the
    extension degrades to "don't trigger" rather than surfacing an error.
    """
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"error": "invalid JSON body"}, status_code=400)

    query = (body or {}).get("query")
    if not query or not isinstance(query, str) or not query.strip():
        return JSONResponse({"error": "query is required"}, status_code=400)

    cfg = core._config()
    # Shares the one budget with the chat route (Fix_11). Cheaper per call, but
    # metered the same — see Fix_11 B5 for why the cap is a single number.
    if not claim_call(cfg, core.BUCKET_INTENT):
        return _quota_response()

    try:
        bedrock = core._bedrock_client(cfg["aws_region"])
        medical = intent.check_medical_intent(bedrock, cfg["intent_model_id"], query)
    except Exception:  # noqa: BLE001 — fail closed, never 500 the interceptor
        core.traceback.print_exc()
        medical = False
    return JSONResponse({"medical": medical})


@app.post("/report")
async def report_route(request: Request):
    """Stream a plain-language reading of an uploaded lab report (bolt-on).

    Reads the user's remembered searches; writes NOTHING. See reports.py for the
    two properties that define this route — no persistence, and no content
    logging even when COMPANION_DEBUG is on. Nothing below may log file bytes,
    decoded text, or the model's output.

    Every validation runs BEFORE the spend gate, and the spend gate runs before
    any Bedrock call — a rejected request must never cost a model invocation.
    """
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"error": "invalid JSON body"}, status_code=400)

    body = body or {}
    user_token = body.get("user_token")
    if not user_token or not isinstance(user_token, str):
        return JSONResponse({"error": "user_token is required"}, status_code=400)

    file_spec = body.get("file")
    if not isinstance(file_spec, dict):
        return JSONResponse({"error": "file is required"}, status_code=400)

    media_type = file_spec.get("media_type")
    if media_type not in reports.MEDIA_TYPES:
        return JSONResponse(
            {"error": "Unsupported file type. Please upload a PDF, PNG or JPEG."},
            status_code=400,
        )

    data = file_spec.get("data")
    if not data or not isinstance(data, str):
        return JSONResponse({"error": "file data is required"}, status_code=400)

    try:
        raw = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError):
        return JSONResponse({"error": "file data is not valid base64"}, status_code=400)
    if not raw:
        return JSONResponse({"error": "file data is empty"}, status_code=400)

    if len(raw) > reports.MAX_REPORT_BYTES:
        return JSONResponse(
            {"error": "That file is larger than 3 MB. Try a photo of the page instead."},
            status_code=413,
        )

    # The declared type must match what the bytes actually are. A renamed file
    # would otherwise reach Bedrock as the wrong block kind.
    if not reports.magic_bytes_agree(media_type, raw):
        return JSONResponse(
            {"error": "That file doesn't look like the type it claims to be."},
            status_code=400,
        )

    cfg = core._config()
    if not cfg["database_url"]:
        return JSONResponse({"error": "DATABASE_URL is not configured"}, status_code=500)

    # Bucket 3 — its own budget, so exhausting the most expensive route cannot
    # take chat or the intent check down with it (and vice versa).
    if _quota_short_circuited(core.BUCKET_REPORT):
        return _quota_response()
    if not claim_call(cfg, core.BUCKET_REPORT):
        return _quota_response()

    # Size and type only — never the bytes, never the name's contents.
    print(f"[report] accepted {media_type} ({len(raw)} bytes)", flush=True)

    bedrock = core._bedrock_client(cfg["aws_region"])
    spec = {"media_type": media_type, "raw": raw, "name": file_spec.get("name")}
    return StreamingResponse(
        reports.analyze(cfg, bedrock, user_token, spec),
        media_type="text/plain; charset=utf-8",
    )


@app.post("/")
async def chat(request: Request):
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"error": "invalid JSON body"}, status_code=400)

    data = core.parse_event(body)
    user_token = data["user_token"]
    user_prompt = data["user_prompt"]

    if not user_token or not user_prompt:
        return JSONResponse(
            {"error": "user_token and user_prompt are required"}, status_code=400
        )

    cfg = core._config()
    if not cfg["database_url"]:
        return JSONResponse({"error": "DATABASE_URL is not configured"}, status_code=500)

    # Cheap per-container reject once the cap is known spent — avoids even
    # opening a connection.
    if _quota_short_circuited(core.BUCKET_CHAT):
        return _quota_response()

    bedrock = core._bedrock_client(cfg["aws_region"])

    # --- pre-stream work (must finish before first byte) -------------------
    # Embed the prompt and gather memory so the system prompt is complete. Any
    # failure here surfaces as a normal HTTP error (we haven't streamed yet).
    try:
        conn = psycopg2.connect(core._normalize_dsn(cfg["database_url"]))
        try:
            # Spend gate FIRST, on this connection, before any Bedrock call —
            # generate_embedding() below is a Titan invocation, so gating after
            # it would let rejected requests still spend.
            if not claim_call_on(conn, cfg, core.BUCKET_CHAT):
                return _quota_response()

            embedding = core.generate_embedding(bedrock, cfg["embedding_model_id"], user_prompt)
            vec_literal = core.to_vector_literal(embedding)

            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    """
                    INSERT INTO user_profiles (user_token, anxiety_tier, communication_style)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (user_token) DO NOTHING
                    """,
                    (user_token, data["anxiety_tier"], data["communication_style"]),
                )
                semantic_rows = core.dedup_semantic(
                    core.fetch_semantic_context(cur, user_token, vec_literal), data["history"]
                )
            conn.commit()
        finally:
            conn.close()

        now = datetime.now(timezone.utc)
        system_prompt = core.render_prompt(
            core.load_system_prompt(),
            page_context=data["page_context"] or "No active page context.",
            semantic_memory=core.format_semantic_memory(semantic_rows, now),
            distress_signal=core.build_distress_signal(user_prompt, semantic_rows, data["history"]),
            current_datetime=now.strftime("%Y-%m-%d %H:%M UTC (%A)"),
        )
        messages = core.build_messages(data["history"], user_prompt)

        if _debug_enabled():
            _debug_dump(user_token, data, semantic_rows, system_prompt, messages, cfg["llm_model_id"])
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"error": str(exc)}, status_code=500)

    # --- streaming generator ----------------------------------------------
    # SYNC generator so Starlette runs it in a threadpool: iterating the
    # (synchronous) Bedrock EventStream and the psycopg2 write never block the
    # event loop. Deltas are accumulated in memory and yielded immediately; the
    # DB write happens only AFTER the stream ends, in a finally so a client
    # disconnect still persists the turn.
    def generate():
        parts = []
        try:
            resp = bedrock.converse_stream(
                modelId=cfg["llm_model_id"],
                system=[{"text": system_prompt}],
                messages=messages,
                inferenceConfig={"maxTokens": 1024, "temperature": 0.5},
            )
            for event in resp["stream"]:
                block = event.get("contentBlockDelta")
                if block:
                    delta = (block.get("delta") or {}).get("text", "")
                    if delta:
                        parts.append(delta)
                        yield delta
        except Exception as exc:  # noqa: BLE001
            core.traceback.print_exc()
            if not parts:
                # Nothing streamed yet — surface a calm fallback line.
                yield (
                    "I'm having a little trouble reaching my thoughts right now. "
                    "You're okay — let's try again in a moment."
                )
        finally:
            persist_turn(cfg, bedrock, user_token, user_prompt, "".join(parts), vec_literal)

    return StreamingResponse(generate(), media_type="text/plain; charset=utf-8")


def persist_turn(cfg, bedrock, user_token, user_prompt, ai_response, vec_literal):
    """Write the completed turn (episode + semantic vector) to CockroachDB.
    Called after generation ends; tolerant of partial/empty responses.

    The turn is also classified (theme + emotion) here rather than pre-stream —
    it's one small Bedrock call that must never sit in front of the first token.
    """
    if not ai_response:
        return
    try:
        label = core.classify_turn(bedrock, cfg["llm_model_id"], user_prompt)
        conn = psycopg2.connect(core._normalize_dsn(cfg["database_url"]))
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
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
                    (
                        user_token,
                        episode_id,
                        user_prompt,
                        label["emotion"],
                        label["theme"],
                        vec_literal,
                    ),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception:  # noqa: BLE001 — never break the response over persistence
        core.traceback.print_exc()
