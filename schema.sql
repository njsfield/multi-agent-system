CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE messages (
  id         BIGSERIAL PRIMARY KEY,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  source     TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE message_embeddings (
  id         BIGSERIAL PRIMARY KEY,
  message_id BIGINT REFERENCES messages(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  embedding  VECTOR(1536),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON message_embeddings USING hnsw (embedding vector_cosine_ops);
