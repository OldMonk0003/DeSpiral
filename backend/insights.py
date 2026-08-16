"""Companion — Patterns & Insights aggregation (bolt-on, READ-ONLY).

Computes a snapshot of a user's long-term memory (themes, time-of-day, emotional
trend, calm streak) via read-only SQL over CockroachDB. No writes; fully isolated
from the chat path. Any failure returns a safe, empty-but-valid shape so the
panel never errors.
"""

from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

import psycopg2
from psycopg2.extras import RealDictCursor

import lambda_handler as core

# Map emotional states to an intensity score for the trend line.
INTENSITY = {"panic": 3.0, "anxious": 2.0, "worried": 1.0, "uneasy": 0.5}

# First-match-wins keyword themes (deterministic; no clustering needed).
THEME_KEYWORDS = [
    ("Heart", ("heart", "palpitation", "chest", "cardiac", "pulse", "racing", "arrhythmia", "skip beat")),
    ("Liver & Gut", ("liver", "alt", "ast", "enzyme", "stomach", "abdominal", "abdomen", "pancrea", "bloating", "colon", "bowel", "yellow")),
    ("Head & Nerves", ("headache", "migraine", "brain", "tumor", "tumour", "tingling", "numb", " ms", "multiple sclerosis", "dizz", "seizure", "nerve")),
    ("Lumps & Cancer", ("lump", "cancer", "lymphoma", "node", "malignant", "biopsy", "mass", "cyst", "armpit")),
]


def _theme_of(text):
    t = (text or "").lower()
    for label, kws in THEME_KEYWORDS:
        if any(k in t for k in kws):
            return label
    return "Other"


def _row_theme(row):
    """Prefer the stored LLM theme (Fix_5); fall back to keyword matching for
    rows written before classification existed (theme IS NULL)."""
    return row.get("theme") or _theme_of(row.get("raw_interaction"))


# Real-world zones span UTC-14:00 .. UTC+14:00. The offset arrives from the
# browser and is therefore untrusted input.
MAX_TZ_OFFSET_MINUTES = 14 * 60


def _clamp_offset(value):
    """Minutes east of UTC, from an untrusted client.

    Anything malformed, missing or out of range degrades to 0 — which is
    exactly the pre-Fix_15 behaviour (everything bucketed in UTC), so a hostile
    or buggy client can only ever get the old output, never an error.
    """
    try:
        minutes = int(value)
    except (TypeError, ValueError):
        return 0
    if -MAX_TZ_OFFSET_MINUTES <= minutes <= MAX_TZ_OFFSET_MINUTES:
        return minutes
    return 0


def _bucket(hour):
    if 6 <= hour <= 11:
        return "Morning"
    if 12 <= hour <= 17:
        return "Afternoon"
    if 18 <= hour <= 21:
        return "Evening"
    return "Night"


def _empty():
    return {
        "total": 0, "active_days": 0, "first": None, "last": None, "span_days": 0,
        "emotions": [], "time_of_day": [], "weekly_volume": [], "emotional_trend": [],
        "themes": [], "calm_streak_days": None,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


def compute(cfg, user_token, tz_offset_minutes=0):
    """Return the insights snapshot dict for a user_token (read-only).

    `tz_offset_minutes` is the viewer's offset east of UTC, supplied by the
    extension. It defaults to 0, so every existing caller keeps today's
    behaviour without an edit.
    """
    try:
        conn = psycopg2.connect(core._normalize_dsn(cfg["database_url"]))
    except Exception:  # noqa: BLE001
        core.traceback.print_exc()
        return _empty()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT raw_interaction, emotional_state, theme, created_at
                FROM semantic_context_memory
                WHERE user_token = %s
                ORDER BY created_at
                """,
                (user_token,),
            )
            rows = cur.fetchall()
    except Exception:  # noqa: BLE001
        core.traceback.print_exc()
        return _empty()
    finally:
        conn.close()

    if not rows:
        return _empty()

    # ---- convert to the viewer's local time ONCE (Fix_15) -------------------
    # created_at is stored UTC and stays UTC in the database — only this read
    # is localised. Converting here, in place, rather than at each call site is
    # deliberate: FIVE figures below derive from these timestamps (time-of-day,
    # active_days, weekly_volume, emotional_trend, calm_streak_days), and
    # patching them individually is five chances to miss one, with every future
    # aggregate wrong by default.
    #
    # astimezone(), NOT `t + timedelta(...)`: adding a delta to an aware
    # datetime shifts the wall clock while leaving tzinfo still claiming UTC,
    # so the object lies about itself and any later comparison or isoformat()
    # is silently wrong.
    tz = timezone(timedelta(minutes=_clamp_offset(tz_offset_minutes)))
    for r in rows:
        if r["created_at"]:
            r["created_at"] = r["created_at"].astimezone(tz)

    # `now` MUST use the same tz: calm_streak_days and span_days subtract
    # timestamps from it, and mixing a local row time with a UTC now would
    # reintroduce the offset as an error in the streak.
    now = datetime.now(tz)
    times = [r["created_at"] for r in rows if r["created_at"]]
    first, last = min(times), max(times)

    # Emotional distribution.
    emo = Counter((r["emotional_state"] or "unknown") for r in rows)
    emotions = [{"state": k, "count": v} for k, v in emo.most_common()]

    # Time-of-day histogram.
    buckets = {"Night": 0, "Morning": 0, "Afternoon": 0, "Evening": 0}
    for t in times:
        buckets[_bucket(t.hour)] += 1
    time_of_day = [{"bucket": b, "count": c} for b, c in buckets.items()]

    # Weekly volume + weekly emotional intensity.
    wk_count = defaultdict(int)
    wk_intensity = defaultdict(list)
    for r in rows:
        t = r["created_at"]
        if not t:
            continue
        iso = t.isocalendar()
        key = f"{iso[0]}-W{iso[1]:02d}"
        wk_count[key] += 1
        wk_intensity[key].append(INTENSITY.get(r["emotional_state"], 1.0))
    weeks = sorted(wk_count.keys())
    weekly_volume = [{"week": w, "count": wk_count[w]} for w in weeks]
    emotional_trend = [
        {"week": w, "score": round(sum(wk_intensity[w]) / len(wk_intensity[w]), 2)}
        for w in weeks
    ]

    # Recurring themes.
    themes = [
        {"theme": k, "count": v}
        for k, v in Counter(_row_theme(r) for r in rows).most_common()
    ]

    # Calm streak: days since the last high-intensity (panic/anxious) turn.
    intense_times = [
        r["created_at"] for r in rows
        if r["emotional_state"] in ("panic", "anxious") and r["created_at"]
    ]
    calm_streak_days = (now - max(intense_times)).days if intense_times else (now - first).days

    return {
        "total": len(rows),
        "active_days": len({t.date() for t in times}),
        "first": first.isoformat(),
        "last": last.isoformat(),
        "span_days": (last - first).days,
        "emotions": emotions,
        "time_of_day": time_of_day,
        "weekly_volume": weekly_volume,
        "emotional_trend": emotional_trend,
        "themes": themes,
        "calm_streak_days": calm_streak_days,
        "generated_at": now.isoformat(),
    }
