-- ============================================================================
-- TS-Agent Database Schema
-- ============================================================================
-- Note: Run this as the 'admin' user on the 'tsagent' database
-- First-time setup: see QUICKSTART.md for full instructions
-- ============================================================================

CREATE TABLE IF NOT EXISTS topics (
  id    BIGSERIAL PRIMARY KEY,
  label TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id         BIGSERIAL PRIMARY KEY,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  source     TEXT NOT NULL,
  topic_id   BIGINT REFERENCES topics(id) ON DELETE SET NULL,
  subtopic   TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS message_embeddings (
  id         BIGSERIAL PRIMARY KEY,
  message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  embedding  VECTOR(1536),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_message_embeddings_embedding
  ON message_embeddings USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS flashcards (
  id                BIGSERIAL PRIMARY KEY,
  question          TEXT NOT NULL,
  answer            TEXT NOT NULL,
  topic_id          BIGINT REFERENCES topics(id) ON DELETE SET NULL,
  subtopic          TEXT,
  source_message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  embedding         VECTOR(1536),
  interval_days     INT NOT NULL DEFAULT 1,
  ease_factor       FLOAT NOT NULL DEFAULT 2.5,
  repetitions       INT NOT NULL DEFAULT 0,
  next_due_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_reviewed_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flashcards_embedding
  ON flashcards USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS mindmap_cache (
  id         INT PRIMARY KEY DEFAULT 1,
  graph      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mindmap_cache_single_row CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS flashcard_reviews (
  id           BIGSERIAL PRIMARY KEY,
  flashcard_id BIGINT NOT NULL REFERENCES flashcards(id) ON DELETE CASCADE,
  score        TEXT NOT NULL CHECK (score IN ('very_easy','easy','hard','fail')),
  sm2_quality  INT NOT NULL,
  reviewed_at  TIMESTAMPTZ DEFAULT now()
);
