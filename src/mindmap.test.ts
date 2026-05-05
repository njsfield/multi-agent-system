import { describe, it, expect, vi } from 'vitest';
import { MindmapService } from './mindmap';
import type pg from 'pg';
import type OpenAI from 'openai';

function makePool(queries: Record<string, any>) {
  let callCount = 0;
  return {
    query: vi.fn(async (sql: string) => {
      callCount++;
      // First call: topics query (GROUP BY m.topic_id)
      if (sql.includes('GROUP BY m.topic_id, t.label')) {
        return queries.topics || { rows: [] };
      }
      // Subsequent calls alternate: subtopics, messages, subtopics, messages, ...
      const callType = (callCount - 1) % 2;
      if (sql.includes('GROUP BY subtopic')) {
        return queries.subtopics || { rows: [] };
      }
      if (sql.includes('ORDER BY id DESC')) {
        return queries.messages || { rows: [] };
      }
      return { rows: [] };
    }),
  } as unknown as pg.Pool;
}

function makeOpenAI(jsonContent = '{"facts":["Key insight 1","Key insight 2"]}') {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: jsonContent } }],
        }),
      },
    },
  } as unknown as OpenAI;
}

describe('MindmapService', () => {
  it('returns empty graph when no topics with messages exist', async () => {
    const pool = makePool({ topics: { rows: [] } });
    const service = new MindmapService(pool, makeOpenAI());

    const graph = await service.getGraph();

    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
  });

  it('generates graph with center node and topic nodes', async () => {
    const pool = makePool({
      topics: {
        rows: [
          { topic_id: 1, label: 'Fitness', message_count: 3 },
          { topic_id: 2, label: 'Finance', message_count: 2 },
        ],
      },
      messages: {
        rows: [
          { content: 'Fitness message 1' },
          { content: 'Fitness message 2' },
          { content: 'Fitness message 3' },
        ],
      },
    });
    const service = new MindmapService(pool, makeOpenAI());

    const graph = await service.getGraph();

    // Center node + 2 topic nodes + fact nodes
    expect(graph.nodes.some(n => n.id === 'center' && n.type === 'center')).toBe(true);
    expect(graph.nodes.some(n => n.id === 'topic-1' && n.type === 'topic')).toBe(true);
    expect(graph.nodes.some(n => n.id === 'topic-2' && n.type === 'topic')).toBe(true);
  });

  it('includes message count in topic label', async () => {
    const pool = makePool({
      topics: {
        rows: [{ topic_id: 1, label: 'Fitness', message_count: 5 }],
      },
      messages: {
        rows: [{ content: 'Test' }],
      },
    });
    const service = new MindmapService(pool, makeOpenAI());

    const graph = await service.getGraph();
    const topicNode = graph.nodes.find(n => n.id === 'topic-1');

    expect(topicNode?.data.label).toBe('Fitness (5)');
  });

  it('creates edges from center to topics', async () => {
    const pool = makePool({
      topics: {
        rows: [{ topic_id: 1, label: 'Fitness', message_count: 1 }],
      },
      messages: {
        rows: [{ content: 'Test' }],
      },
    });
    const service = new MindmapService(pool, makeOpenAI());

    const graph = await service.getGraph();
    const centerEdge = graph.edges.find(e => e.source === 'center' && e.target === 'topic-1');

    expect(centerEdge).toBeDefined();
  });

  it('extracts and adds fact nodes under topics', async () => {
    const pool = makePool({
      topics: {
        rows: [{ topic_id: 1, label: 'Fitness', message_count: 1 }],
      },
      messages: {
        rows: [{ content: 'Running improves heart health' }],
      },
    });
    const service = new MindmapService(pool, makeOpenAI('{"facts":["Running improves health"]}'));

    const graph = await service.getGraph();
    const factNode = graph.nodes.find(n => n.type === 'fact' && n.id?.startsWith('fact-1'));

    expect(factNode).toBeDefined();
    expect(factNode?.data.label).toBe('Running improves health');
  });

  it('includes updatedAt timestamp', async () => {
    const pool = makePool({ topics: { rows: [] } });
    const service = new MindmapService(pool, makeOpenAI());
    const before = new Date();

    const graph = await service.getGraph();
    const after = new Date();

    expect(graph.updatedAt).toBeDefined();
    const timestamp = new Date(graph.updatedAt!);
    expect(timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('falls back to fact extraction when no subtopics available', async () => {
    const pool = makePool({
      topics: {
        rows: [{ topic_id: 1, label: 'Fitness', message_count: 1 }],
      },
      subtopics: {
        rows: [], // No subtopics, should extract facts
      },
      messages: {
        rows: [{ content: 'Test message' }],
      },
    });
    const service = new MindmapService(pool, makeOpenAI('{"facts":["Key insight"]}')); // Extracted facts

    const graph = await service.getGraph();
    const topicNode = graph.nodes.find(n => n.id === 'topic-1');

    expect(topicNode).toBeDefined(); // Topic still exists
    // Should have center, topic, and fact nodes
    expect(graph.nodes.length).toBeGreaterThan(2);
  });
});
