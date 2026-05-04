import pg from 'pg';
import OpenAI from 'openai';
import { kmeans } from 'ml-kmeans';
import type { MindmapGraph, MindmapNode, MindmapEdge } from './types';

const TOPIC_COLORS = [
  '#3b82f6', '#22c55e', '#f97316', '#a855f7',
  '#06b6d4', '#eab308', '#ec4899', '#14b8a6',
];

function cosineDist(a: number[], b: number[]): number {
  if (a.length !== b.length) return 1;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 1 : 1 - dot / denom;
}

export class MindmapService {
  private pool: pg.Pool;
  private openai: OpenAI;
  private isRecomputing = false;

  constructor(pool: pg.Pool, openai: OpenAI) {
    this.pool = pool;
    this.openai = openai;
  }

  async getGraph(): Promise<MindmapGraph> {
    const { rows } = await this.pool.query<{ graph: MindmapGraph; updated_at: string }>(
      'SELECT graph, updated_at FROM mindmap_cache WHERE id = 1',
    );
    if (!rows[0]) return { nodes: [], edges: [] };
    return { ...rows[0].graph, updatedAt: rows[0].updated_at };
  }

  async recompute(): Promise<void> {
    if (this.isRecomputing) return;
    this.isRecomputing = true;
    try {
      await this._run();
    } catch (err) {
      console.error('[MindmapService] recompute failed:', err);
    } finally {
      this.isRecomputing = false;
    }
  }

  private async _run(): Promise<void> {
    const { rows } = await this.pool.query<{ id: number; content: string; embedding: string }>(
      `SELECT me.id, me.content, me.embedding
       FROM message_embeddings me
       JOIN messages m ON m.id = me.message_id
       ORDER BY m.id ASC`,
    );

    if (rows.length < 6) {
      await this._upsert({ nodes: [], edges: [] });
      return;
    }

    const vectors = rows.map(r => JSON.parse(r.embedding) as number[]);
    const k = Math.min(Math.ceil(rows.length / 5), 8);

    let result;
    try {
      result = kmeans(vectors, k, { initialization: 'kmeans++', maxIterations: 100 });
    } catch (err) {
      console.error('[MindmapService] k-means failed:', err);
      await this._upsert({ nodes: [], edges: [] });
      return;
    }

    const nodes: MindmapNode[] = [{ id: 'center', type: 'center', data: { label: 'All Topics' } }];
    const edges: MindmapEdge[] = [];

    for (let ci = 0; ci < k; ci++) {
      const centroid = result.centroids[ci]!;
      const members = rows
        .map((r, i) => ({ content: r.content, clusterIdx: result.clusters[i], dist: cosineDist(vectors[i]!, centroid) }))
        .filter(r => r.clusterIdx === ci)
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 3);

      if (members.length === 0) continue;

      const label = await this._label(members.map(m => m.content), ci);
      const topicId = `topic-${ci}`;

      nodes.push({ id: topicId, type: 'topic', data: { label: label.topic, color: TOPIC_COLORS[ci % TOPIC_COLORS.length] } });
      edges.push({ id: `e-center-${ci}`, source: 'center', target: topicId });

      label.facts.forEach((fact, fi) => {
        const factId = `fact-${ci}-${fi}`;
        nodes.push({ id: factId, type: 'fact', data: { label: fact } });
        edges.push({ id: `e-${ci}-f${fi}`, source: topicId, target: factId });
      });
    }

    await this._upsert({ nodes, edges });
  }

  private async _label(excerpts: string[], idx: number): Promise<{ topic: string; facts: string[] }> {
    const fallback = { topic: `Topic ${idx + 1}`, facts: [] };
    try {
      const res = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content: `These are excerpts from a conversation:\n${excerpts.join('\n')}\n\nName the topic in 2-4 words, then list up to 3 facts (each under 8 words). Reply as JSON: {"topic":"...","facts":["..."]}`,
        }],
        response_format: { type: 'json_object' },
      });
      const raw = res.choices[0]?.message.content ?? '{}';
      const parsed = JSON.parse(raw) as { topic?: string; facts?: string[] };
      return {
        topic: typeof parsed.topic === 'string' ? parsed.topic : fallback.topic,
        facts: Array.isArray(parsed.facts)
          ? parsed.facts.filter((f): f is string => typeof f === 'string').slice(0, 3)
          : [],
      };
    } catch {
      return fallback;
    }
  }

  private async _upsert(graph: Omit<MindmapGraph, 'updatedAt'>): Promise<void> {
    await this.pool.query(
      `INSERT INTO mindmap_cache (id, graph)
       VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET graph = EXCLUDED.graph, updated_at = now()`,
      [JSON.stringify(graph)],
    );
  }
}
