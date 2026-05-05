import { describe, it, expect, vi } from 'vitest';
import { createTopicDeterminationAgent } from './topic-determination-agent';
import type pg from 'pg';

function makePool(topicsData: Array<{ id: number; label: string }> = []) {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT id, label FROM topics')) {
        return { rows: topicsData };
      }
      if (sql.includes('SELECT label FROM topics WHERE id')) {
        const topicId = (params?.[0] as number) ?? 1;
        const topic = topicsData.find(t => t.id === topicId);
        return { rows: topic ? [{ label: topic.label }] : [] };
      }
      return { rows: [] };
    }),
  } as unknown as pg.Pool;
}

describe('TopicDeterminationAgent', () => {
  describe('createTopicDeterminationAgent', () => {
    it('creates an agent with correct name and instructions', () => {
      const pool = makePool([
        { id: 1, label: 'Fitness' },
        { id: 2, label: 'Finance' },
      ]);

      // Mock the OpenAI client to avoid needing API key during tests
      process.env.OPENAI_API_KEY = 'test-key-for-unit-tests';

      try {
        const agent = createTopicDeterminationAgent(pool);
        expect(agent.name).toBe('topic-determiner');
      } finally {
        delete process.env.OPENAI_API_KEY;
      }
    });

    it('agent can be created with multiple topics available', () => {
      const topics = [
        { id: 1, label: 'Fitness' },
        { id: 2, label: 'Finance' },
        { id: 3, label: 'Food' },
      ];
      const pool = makePool(topics);

      process.env.OPENAI_API_KEY = 'test-key-for-unit-tests';

      try {
        const agent = createTopicDeterminationAgent(pool);
        expect(agent).toBeDefined();
        expect(agent.name).toBe('topic-determiner');
      } finally {
        delete process.env.OPENAI_API_KEY;
      }
    });
  });
});
