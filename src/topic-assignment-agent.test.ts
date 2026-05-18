import { describe, it, expect, vi } from 'vitest';
import { TopicAssignmentAgent } from './topic-assignment-agent';
import type pg from 'pg';
import type OpenAI from 'openai';

// Shared query handler — used by both pool.query and client.query so all SQL is tracked.
function makeMockPool(config: {
  cards?: Array<{ id: number; question: string; answer: string }>;
  topics?: Array<{ id: number; label: string; parent_id: number | null; card_count: string }>;
  splitGuard?: { count: string; parent_id: number | null };
  topicCards?: Array<{ id: number; question: string; answer: string }>;
  topicLabel?: string;
  countAfterAssign?: string;
} = {}) {
  let nextId = 100;
  const allSql: string[] = [];

  const handle = vi.fn(async (sql: string, _params?: unknown[]) => {
    allSql.push(sql);
    if (sql.includes('SELECT id, question, answer FROM flashcards WHERE id = ANY')) {
      return { rows: config.cards ?? [] };
    }
    if (sql.includes('SELECT t.id, t.label, t.parent_id, COUNT')) {
      return { rows: config.topics ?? [] };
    }
    if (sql.includes('INSERT INTO topics') && sql.includes('RETURNING id')) {
      return { rows: [{ id: nextId++ }] };
    }
    if (sql.includes('UPDATE flashcards SET topic_id')) {
      return { rows: [] };
    }
    if (sql.includes('COUNT(*) AS count, t.parent_id') || sql.includes('COUNT(f.id) AS count')) {
      return { rows: [config.splitGuard ?? { count: '3', parent_id: null }] };
    }
    if (sql.includes('SELECT id, question, answer FROM flashcards WHERE topic_id')) {
      return { rows: config.topicCards ?? [] };
    }
    if (sql.includes('SELECT label FROM topics WHERE id')) {
      return { rows: [{ label: config.topicLabel ?? 'Data Structures' }] };
    }
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [] };
    }
    return { rows: [] };
  });

  const pool = {
    query: handle,
    connect: vi.fn(async () => ({ query: handle, release: vi.fn() })),
    _allSql: allSql,
    _handle: handle,
  } as unknown as pg.Pool & { _allSql: string[]; _handle: typeof handle };

  return pool;
}

function makeMockOpenAI(response: object) {
  return {
    chat: {
      completions: {
        create: vi.fn(async () => ({
          choices: [{ message: { content: JSON.stringify(response) } }],
        })),
      },
    },
  } as unknown as OpenAI;
}

describe('TopicAssignmentAgent', () => {
  describe('assignTopics', () => {
    it('assigns a flashcard to an existing topic', async () => {
      const pool = makeMockPool({
        cards: [{ id: 1, question: 'What is O(n)?', answer: 'Linear time' }],
        topics: [{ id: 3, label: 'Algorithms', parent_id: null, card_count: '2' }],
      });
      const openai = makeMockOpenAI({ assignments: [{ flashcardId: 1, topicId: 3 }] });
      const agent = new TopicAssignmentAgent(pool, openai);

      await agent.assignTopics([1]);

      const updateCall = pool._handle.mock.calls.find(
        (c) => (c[0] as string).includes('UPDATE flashcards SET topic_id'),
      );
      expect(updateCall).toBeDefined();
      expect(updateCall![1]).toEqual([3, 1]);
    });

    it('creates a new topic when the LLM returns newTopicLabel', async () => {
      const pool = makeMockPool({
        cards: [{ id: 2, question: 'What is recursion?', answer: 'A function calling itself' }],
        topics: [],
      });
      const openai = makeMockOpenAI({ assignments: [{ flashcardId: 2, newTopicLabel: 'Recursion' }] });
      const agent = new TopicAssignmentAgent(pool, openai);

      await agent.assignTopics([2]);

      const insertCall = pool._handle.mock.calls.find(
        (c) => (c[0] as string).includes('INSERT INTO topics'),
      );
      expect(insertCall).toBeDefined();
      expect(insertCall![1]).toContain('Recursion');
    });

    it('deduplicates new topic labels within the same batch', async () => {
      const pool = makeMockPool({
        cards: [
          { id: 1, question: 'Q1', answer: 'A1' },
          { id: 2, question: 'Q2', answer: 'A2' },
        ],
        topics: [],
      });
      const openai = makeMockOpenAI({
        assignments: [
          { flashcardId: 1, newTopicLabel: 'Recursion' },
          { flashcardId: 2, newTopicLabel: 'Recursion' },
        ],
      });
      const agent = new TopicAssignmentAgent(pool, openai);

      await agent.assignTopics([1, 2]);

      const insertCalls = pool._handle.mock.calls.filter(
        (c) => (c[0] as string).includes('INSERT INTO topics'),
      );
      expect(insertCalls).toHaveLength(1);
    });

    it('does not trigger split when topic count is below threshold', async () => {
      const pool = makeMockPool({
        cards: [{ id: 1, question: 'Q', answer: 'A' }],
        topics: [{ id: 3, label: 'Algorithms', parent_id: null, card_count: '1' }],
        splitGuard: { count: '2', parent_id: null }, // below 6
      });
      const openai = makeMockOpenAI({ assignments: [{ flashcardId: 1, topicId: 3 }] });
      const agent = new TopicAssignmentAgent(pool, openai);
      const splitSpy = vi.spyOn(agent, 'splitTopic');

      await agent.assignTopics([1]);

      expect(splitSpy).not.toHaveBeenCalled();
    });
  });

  describe('splitTopic', () => {
    it('creates two child topics and reassigns cards', async () => {
      const pool = makeMockPool({
        splitGuard: { count: '6', parent_id: null },
        topicCards: [
          { id: 1, question: 'Q1', answer: 'A1' },
          { id: 2, question: 'Q2', answer: 'A2' },
          { id: 3, question: 'Q3', answer: 'A3' },
          { id: 4, question: 'Q4', answer: 'A4' },
          { id: 5, question: 'Q5', answer: 'A5' },
          { id: 6, question: 'Q6', answer: 'A6' },
        ],
      });
      const openai = makeMockOpenAI({
        group1: { label: 'Sorting', flashcardIds: [1, 2, 3] },
        group2: { label: 'Searching', flashcardIds: [4, 5, 6] },
      });
      const agent = new TopicAssignmentAgent(pool, openai);

      await agent.splitTopic(5);

      const insertCalls = pool._handle.mock.calls.filter(
        (c) => (c[0] as string).includes('INSERT INTO topics'),
      );
      expect(insertCalls).toHaveLength(2);
      expect(insertCalls[0]![1]).toContain('Sorting');
      expect(insertCalls[1]![1]).toContain('Searching');
    });

    it('aborts if LLM puts all cards in one group', async () => {
      const pool = makeMockPool({
        splitGuard: { count: '6', parent_id: null },
        topicCards: [{ id: 1, question: 'Q', answer: 'A' }],
      });
      const openai = makeMockOpenAI({
        group1: { label: 'All', flashcardIds: [1, 2, 3, 4, 5, 6] },
        group2: { label: 'Empty', flashcardIds: [] },
      });
      const agent = new TopicAssignmentAgent(pool, openai);

      await agent.splitTopic(5);

      const insertCalls = pool._handle.mock.calls.filter(
        (c) => (c[0] as string).includes('INSERT INTO topics'),
      );
      expect(insertCalls).toHaveLength(0);
    });

    it('aborts if topic already has a parent (idempotency guard)', async () => {
      const pool = makeMockPool({
        splitGuard: { count: '6', parent_id: 1 }, // has parent
      });
      const openai = makeMockOpenAI({});
      const agent = new TopicAssignmentAgent(pool, openai);

      await agent.splitTopic(5);

      expect((openai.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });
  });
});
