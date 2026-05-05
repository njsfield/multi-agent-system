import pg from 'pg';
import OpenAI from 'openai';
import { BaseMemory } from './memory';
import { determineMessageTopic } from './topic-determination-agent';
import type { HistoryMessage } from './types';

function isMarkdown(text: string): boolean {
  return (
    /^#{1,6}\s/m.test(text) ||
    /^\s*[-*+]\s/m.test(text) ||
    /^\s*\d+\.\s/m.test(text) ||
    /`[^`]+`/.test(text) ||
    /^```/m.test(text) ||
    /\*\*[^*]+\*\*/.test(text) ||
    /^>\s/m.test(text)
  );
}

export function createPgPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString });
}

export class PgVectorMemory extends BaseMemory {
  private pool: pg.Pool;
  private openai: OpenAI;

  constructor(pool: pg.Pool, openai: OpenAI) {
    super();
    this.pool = pool;
    this.openai = openai;
  }

  async add(content: string, metadata: Record<string, unknown> = {}): Promise<void> {
    const role   = String(metadata['role']   ?? 'user');
    const source = String(metadata['source'] ?? 'unknown');

    const { rows } = await this.pool.query<{ id: number }>(
      'INSERT INTO messages (role, content, source) VALUES ($1, $2, $3) RETURNING id',
      [role, content, source],
    );
    const messageId = rows[0]!.id;

    // Determine topic asynchronously (fire-and-forget, don't block message storage)
    determineMessageTopic(content, this.pool)
      .then(assignment => {
        if (assignment) {
          return this.pool.query(
            'UPDATE messages SET topic_id = $1, subtopic = $2 WHERE id = $3',
            [assignment.topicId, assignment.subtopic, messageId],
          );
        }
      })
      .catch(err => {
        console.error('[PgVectorMemory] Topic determination failed:', err);
      });

    try {
      const res = await this.openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: content,
      });
      const embedding = res.data[0]!.embedding;
      await this.pool.query(
        'INSERT INTO message_embeddings (message_id, content, embedding) VALUES ($1, $2, $3)',
        [messageId, content, JSON.stringify(embedding)],
      );
    } catch (err) {
      console.error('[PgVectorMemory] embedding failed, skipping vector insert:', err);
    }
  }

  async query(query: string, limit = 5): Promise<string[]> {
    const res = await this.openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: query,
    });
    const embedding = res.data[0]!.embedding;

    const { rows } = await this.pool.query<{ role: string; content: string }>(
      `SELECT m.role, me.content
       FROM message_embeddings me
       JOIN messages m ON m.id = me.message_id
       ORDER BY me.embedding <=> $1
       LIMIT $2`,
      [JSON.stringify(embedding), limit],
    );

    return rows.map(r => `${r.role}: ${r.content}`);
  }

  async getContext(maxItems = 20): Promise<string[]> {
    const { rows } = await this.pool.query<{ role: string; content: string }>(
      `SELECT role, content
       FROM (SELECT role, content, id FROM messages ORDER BY id DESC LIMIT $1) sub
       ORDER BY id ASC`,
      [maxItems],
    );
    return rows.map(r => `${r.role}: ${r.content}`);
  }

  async getHistory(limit: number): Promise<HistoryMessage[]> {
    const { rows } = await this.pool.query<{
      id: number;
      role: string;
      content: string;
      source: string;
      topic_id: number | null;
      subtopic: string | null;
      created_at: string;
    }>(
      'SELECT id, role, content, source, topic_id, subtopic, created_at FROM messages ORDER BY id ASC LIMIT $1',
      [limit],
    );
    return rows.map(r => ({
      id:          r.id,
      role:        r.role as 'user' | 'assistant',
      content:     r.content,
      source:      r.source,
      topicId:     r.topic_id,
      subtopic:    r.subtopic,
      contentType: isMarkdown(r.content) ? 'markdown' : 'text',
      createdAt:   r.created_at,
    }));
  }
}
