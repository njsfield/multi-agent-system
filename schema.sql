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

CREATE TABLE mindmap_cache (
  id         INT PRIMARY KEY DEFAULT 1,
  graph      JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);
