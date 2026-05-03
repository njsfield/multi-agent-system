-- Connect to postgres to set up the DB and User
-- (If these already exist from your last run, it might show errors, which is fine)
CREATE USER admin WITH PASSWORD 'postgres';
CREATE DATABASE tsagent OWNER admin;

-- 1. Connect to the new database as SUPERUSER (postgres)
\c tsagent postgres

-- 2. Enable the extension as superuser
CREATE EXTENSION IF NOT EXISTS vector;

-- 3. Now switch to admin for the tables
\c tsagent admin

CREATE TABLE messages (
  id         BIGSERIAL PRIMARY KEY,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  source     TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE message_embeddings (
  id         BIGSERIAL PRIMARY KEY,
  message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  embedding  VECTOR(1536),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON message_embeddings USING hnsw (embedding vector_cosine_ops);

CREATE TABLE flashcards (
  id                BIGSERIAL PRIMARY KEY,
  question          TEXT NOT NULL,
  answer            TEXT NOT NULL,
  topic_label       TEXT,
  source_message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  embedding         VECTOR(1536),
  interval_days     INT NOT NULL DEFAULT 1,
  ease_factor       FLOAT NOT NULL DEFAULT 2.5,
  repetitions       INT NOT NULL DEFAULT 0,
  next_due_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_reviewed_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON flashcards USING hnsw (embedding vector_cosine_ops);

CREATE TABLE flashcard_reviews (
  id           BIGSERIAL PRIMARY KEY,
  flashcard_id BIGINT NOT NULL REFERENCES flashcards(id) ON DELETE CASCADE,
  score        TEXT NOT NULL CHECK (score IN ('very_easy','easy','hard','fail')),
  sm2_quality  INT NOT NULL,
  reviewed_at  TIMESTAMPTZ DEFAULT now()
);
