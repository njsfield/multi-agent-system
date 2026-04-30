import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgVectorMemory } from './pg-memory';
import type pg from 'pg';
import type OpenAI from 'openai';

const fakeEmbedding = new Array(1536).fill(0.1);

function makePool(queryImpl: ReturnType<typeof vi.fn> = vi.fn()) {
  return { query: queryImpl } as unknown as pg.Pool;
}

function makeOpenAI(embedding = fakeEmbedding) {
  return {
    embeddings: {
      create: vi.fn().mockResolvedValue({ data: [{ embedding }] }),
    },
  } as unknown as OpenAI;
}

describe('PgVectorMemory', () => {
  describe('add', () => {
    it('inserts into messages and message_embeddings', async () => {
      const query = vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: 1 }] })
        .mockResolvedValueOnce({ rows: [] });
      const openai = makeOpenAI();
      const memory = new PgVectorMemory(makePool(query), openai);

      await memory.add('hello world', { role: 'user', source: 'user' });

      expect(query).toHaveBeenCalledTimes(2);
      expect(query).toHaveBeenNthCalledWith(
        1,
        'INSERT INTO messages (role, content, source) VALUES ($1, $2, $3) RETURNING id',
        ['user', 'hello world', 'user'],
      );
      expect(openai.embeddings.create).toHaveBeenCalledWith({
        model: 'text-embedding-3-small',
        input: 'hello world',
      });
    });

    it('still persists to messages when embedding fails', async () => {
      const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: 1 }] });
      const openai = {
        embeddings: { create: vi.fn().mockRejectedValue(new Error('API error')) },
      } as unknown as OpenAI;
      const memory = new PgVectorMemory(makePool(query), openai);

      await memory.add('hello', { role: 'user', source: 'user' });

      expect(query).toHaveBeenCalledTimes(1);
    });
  });

  describe('query', () => {
    it('returns role-prefixed content strings from cosine similarity search', async () => {
      const query = vi.fn().mockResolvedValue({
        rows: [{ role: 'assistant', content: 'sunny in Tokyo' }],
      });
      const openai = makeOpenAI();
      const memory = new PgVectorMemory(makePool(query), openai);

      const results = await memory.query('weather in Tokyo', 3);

      expect(results).toEqual(['assistant: sunny in Tokyo']);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('ORDER BY me.embedding <=>'),
        [JSON.stringify(fakeEmbedding), 3],
      );
    });
  });

  describe('getContext', () => {
    it('returns recent messages as "role: content" strings, oldest first', async () => {
      const query = vi.fn().mockResolvedValue({
        rows: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi there' },
        ],
      });
      const memory = new PgVectorMemory(makePool(query), makeOpenAI());

      const results = await memory.getContext(10);

      expect(results).toEqual(['user: hello', 'assistant: hi there']);
    });
  });

  describe('getHistory', () => {
    it('returns history with contentType derived from content', async () => {
      const query = vi.fn().mockResolvedValue({
        rows: [
          { id: 1, role: 'user', content: 'hello', source: 'user', created_at: '2026-04-30T00:00:00Z' },
          { id: 2, role: 'assistant', content: '## Response\nHi!', source: 'agent', created_at: '2026-04-30T00:00:01Z' },
        ],
      });
      const memory = new PgVectorMemory(makePool(query), makeOpenAI());

      const results = await memory.getHistory(50);

      expect(results).toEqual([
        { id: 1, role: 'user', content: 'hello', source: 'user', contentType: 'text', createdAt: '2026-04-30T00:00:00Z' },
        { id: 2, role: 'assistant', content: '## Response\nHi!', source: 'agent', contentType: 'markdown', createdAt: '2026-04-30T00:00:01Z' },
      ]);
    });
  });
});
