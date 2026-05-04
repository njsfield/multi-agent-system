import { describe, it, expect, vi } from 'vitest';
import { MindmapService } from './mindmap';
import type pg from 'pg';
import type OpenAI from 'openai';

function makePool(queryImpl = vi.fn()) {
  return { query: queryImpl } as unknown as pg.Pool;
}

function makeOpenAI(jsonContent = '{"topic":"Weather","facts":["Discussed London weather"]}') {
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
  describe('getGraph', () => {
    it('returns empty graph when no cache row exists', async () => {
      const pool = makePool(vi.fn().mockResolvedValue({ rows: [] }));
      const service = new MindmapService(pool, makeOpenAI());

      const graph = await service.getGraph();

      expect(graph).toEqual({ nodes: [], edges: [] });
    });

    it('returns parsed graph with updatedAt from cache row', async () => {
      const cachedGraph = {
        nodes: [{ id: 'center', type: 'center', data: { label: 'All Topics' } }],
        edges: [],
      };
      const pool = makePool(
        vi.fn().mockResolvedValue({
          rows: [{ graph: cachedGraph, updated_at: '2026-05-03T00:00:00Z' }],
        }),
      );
      const service = new MindmapService(pool, makeOpenAI());

      const result = await service.getGraph();

      expect(result.nodes).toHaveLength(1);
      expect(result.updatedAt).toBe('2026-05-03T00:00:00Z');
    });
  });

  describe('recompute', () => {
    it('upserts empty graph when fewer than 6 embeddings exist', async () => {
      const fakeEmbedding = JSON.stringify(new Array(4).fill(0.1));
      const query = vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: 1, content: 'hello', embedding: fakeEmbedding }] })
        .mockResolvedValueOnce({ rows: [] }); // upsert
      const service = new MindmapService(makePool(query), makeOpenAI());

      await service.recompute();

      const upsertCall = query.mock.calls.find(c =>
        String(c[0]).includes('ON CONFLICT'),
      );
      expect(upsertCall).toBeDefined();
      const upserted = JSON.parse(String(upsertCall![1][0]));
      expect(upserted.nodes).toHaveLength(0);
      expect(upserted.edges).toHaveLength(0);
    });

    it('skips concurrent call while recompute is already running', async () => {
      let resolveQuery!: (v: unknown) => void;
      const query = vi.fn().mockReturnValueOnce(
        new Promise(r => { resolveQuery = r; }),
      );
      const service = new MindmapService(makePool(query), makeOpenAI());

      const p1 = service.recompute();
      const p2 = service.recompute(); // should skip immediately
      await p2; // resolves right away — no additional queries

      expect(query).toHaveBeenCalledTimes(1); // only p1's fetch
      resolveQuery({ rows: [] }); // let p1 finish
      await p1;
    });

    it('does not throw when recompute encounters an error', async () => {
      const pool = makePool(vi.fn().mockRejectedValue(new Error('DB down')));
      const service = new MindmapService(pool, makeOpenAI());

      await expect(service.recompute()).resolves.not.toThrow();
    });

    describe('cosineDist edge cases (via recompute with mismatched embeddings)', () => {
      it('handles mismatched vector dimensions gracefully without throwing', async () => {
        // Mix of 4-dim and 3-dim embeddings - should not throw
        const query = vi.fn()
          .mockResolvedValueOnce({
            rows: [
              { id: 1, content: 'a', embedding: JSON.stringify([0.1, 0.2, 0.3, 0.4]) },
              { id: 2, content: 'b', embedding: JSON.stringify([0.5, 0.6, 0.7]) }, // mismatched
              { id: 3, content: 'c', embedding: JSON.stringify([0.1, 0.2, 0.3, 0.4]) },
              { id: 4, content: 'd', embedding: JSON.stringify([0.5, 0.6, 0.7, 0.8]) },
              { id: 5, content: 'e', embedding: JSON.stringify([0.1, 0.2, 0.3, 0.4]) },
              { id: 6, content: 'f', embedding: JSON.stringify([0.5, 0.6, 0.7, 0.8]) },
            ],
          })
          .mockResolvedValue({ rows: [] });
        const service = new MindmapService(makePool(query), makeOpenAI());

        await expect(service.recompute()).resolves.not.toThrow();
      });
    });
  });
});
