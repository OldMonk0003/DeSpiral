-- Companion — CockroachDB schema (BackEnd Epic A1)
-- Target: cluster "old-monk" (CockroachDB v26.2.1), database: defaultdb
-- Applied via the CockroachDB Cloud MCP tools; this file is the versioned
-- source of truth for the schema.
--
-- Deviations from the Epic's raw script (CockroachDB-specific, verified live):
--   * CREATE EXTENSION vector is omitted — CockroachDB v26.2 has NATIVE VECTOR
--     support; the pgvector `CREATE EXTENSION` step is a Postgres-ism that
--     CockroachDB neither needs nor supports.
--   * The vector index is declared INLINE in the CREATE TABLE (rather than a
--     separate CREATE VECTOR INDEX). CockroachDB resolves it to a C-SPANN
--     VECTOR INDEX using the vector_l2_ops operator class.

-- 0. API spend quota (Fix_11) — ONE row, both caps.
--    A row-per-day table cannot enforce the lifetime cap atomically alongside
--    the daily one: composing them with a data-modifying CTE is subtly wrong,
--    because such a CTE runs whether or not the outer statement matches, so a
--    request rejected by the daily cap would still drain the lifetime counter.
--    One ROW per budget bucket (Fix_13): 1 = chat, 2 = /intent, 3 = /report.
--    Rows rather than extra columns, because each row carries its own `day` —
--    with a shared day column, whichever statement rolled the date would also
--    have to reset the other bucket's counter or yesterday's total would linger.
--    Bucket 3 is sized lower than the others because a report call costs several
--    times more (image/PDF tokens + 20 searches of context + output).
CREATE TABLE IF NOT EXISTS api_usage (
    id          INT PRIMARY KEY,
    day         DATE NOT NULL DEFAULT current_date(),
    calls_today INT NOT NULL DEFAULT 0,
    calls_total INT NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ DEFAULT now()
);
INSERT INTO api_usage (id, day, calls_today, calls_total)
VALUES (1, current_date(), 0, 0), (2, current_date(), 0, 0), (3, current_date(), 0, 0)
ON CONFLICT (id) DO NOTHING;

-- 1. User Profiles & Settings
CREATE TABLE IF NOT EXISTS user_profiles (
    user_token VARCHAR(128) PRIMARY KEY,
    anxiety_tier VARCHAR(20) DEFAULT 'severe',
    communication_style VARCHAR(30) DEFAULT 'gentle_soft',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 2. Episodic Memory Ledger (Relational History)
CREATE TABLE IF NOT EXISTS patient_episodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_token VARCHAR(128) NOT NULL REFERENCES user_profiles(user_token) ON DELETE CASCADE,
    user_prompt TEXT NOT NULL,
    ai_response TEXT NOT NULL,
    recorded_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    INDEX idx_episodes_user_token (user_token)
);

-- 3. Semantic Memory Vault (Distributed Vector Indexing)
CREATE TABLE IF NOT EXISTS semantic_context_memory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_token VARCHAR(128) NOT NULL REFERENCES user_profiles(user_token) ON DELETE CASCADE,
    episode_id UUID REFERENCES patient_episodes(id) ON DELETE CASCADE,
    raw_interaction TEXT NOT NULL,
    emotional_state VARCHAR(50),
    -- Worry theme from the CLASSIFY_THEMES taxonomy (lambda_handler.classify_turn).
    -- Nullable: rows written before Fix_5 fall back to keyword themes in insights.py.
    theme VARCHAR(40),
    embedding VECTOR(1024),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    INDEX idx_semantic_user_token (user_token),
    -- Dedicated distributed vector index (C-SPANN)
    VECTOR INDEX idx_semantic_embedding (embedding)
);
