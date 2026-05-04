import { describe, it, expect, vi } from 'vitest';
import { FlashcardExtractor } from './flashcard-extractor';
import type pg from 'pg';
import type OpenAI from 'openai';

const fakeEmbedding = new Array(1536).fill(0.1);

function makePool(queryImpl: ReturnType<typeof vi.fn> = vi.fn()) {
  return { query: queryImpl } as unknown as pg.Pool;
}

function makeOpenAI(opts: { extractContent?: string; dupContent?: string } = {}) {
  return {
    chat: {
      completions: {
        create: vi.fn()
          .mockResolvedValueOnce({
            choices: [{ message: { content: opts.extractContent ?? '{"question":"What is Paris?","answer":"The capital of France."}' } }],
          })
          .mockResolvedValueOnce({
            choices: [{ message: { content: opts.dupContent ?? '{"isDuplicate":false}' } }],
          }),
      },
    },
    embeddings: {
      create: vi.fn().mockResolvedValue({ data: [{ embedding: fakeEmbedding }] }),
    },
  } as unknown as OpenAI;
}

describe('FlashcardExtractor', () => {
  describe('extract', () => {
    it('inserts a flashcard when a fact is extracted and no duplicate exists', async () => {
      const query = vi.fn()
        .mockResolvedValueOnce({ rows: [] })   // dedup: no near-matches
        .mockResolvedValueOnce({ rows: [] })   // mindmap_cache: empty
        .mockResolvedValueOnce({ rows: [] });  // INSERT
      const extractor = new FlashcardExtractor(makePool(query), makeOpenAI());

      await extractor.extract('What is the capital of France?', 'The capital of France is Paris.');

      const insertCall = query.mock.calls.find(c => String(c[0]).includes('INSERT INTO flashcards'));
      expect(insertCall).toBeDefined();
    });

    it('skips when LLM returns null extraction', async () => {
      const openai = makeOpenAI({ extractContent: '{"result":null}' });
      const query = vi.fn();
      const extractor = new FlashcardExtractor(makePool(query), openai);

      await extractor.extract('How are you?', 'Doing well!');

      expect(query).not.toHaveBeenCalled();
    });

    it('skips when duplicate is detected', async () => {
      const query = vi.fn()
        .mockResolvedValueOnce({ rows: [{ question: 'What is Paris?' }] }); // near-match
      const openai = makeOpenAI({ dupContent: '{"isDuplicate":true}' });
      const extractor = new FlashcardExtractor(makePool(query), openai);

      await extractor.extract('What is the capital of France?', 'Paris.');

      const insertCall = query.mock.calls.find(c => String(c[0]).includes('INSERT INTO flashcards'));
      expect(insertCall).toBeUndefined();
    });

    it('stamps topic_label when mindmap topics exist', async () => {
      const mindmapGraph = {
        nodes: [
          { type: 'topic', data: { label: 'Geography' } },
          { type: 'topic', data: { label: 'History' } },
        ],
      };
      const query = vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ graph: mindmapGraph }] })
        .mockResolvedValueOnce({ rows: [] });
      const extractor = new FlashcardExtractor(makePool(query), makeOpenAI());

      await extractor.extract('What is the capital of France?', 'Paris.');

      const insertCall = query.mock.calls.find(c => String(c[0]).includes('INSERT INTO flashcards'));
      expect(insertCall).toBeDefined();
    });
  });
});
