-- src/scripts/migrate-topic-schema.sql
ALTER TABLE topics ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES topics(id) NULL;
ALTER TABLE flashcards DROP COLUMN IF EXISTS subtopic;
