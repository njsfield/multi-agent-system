import pg from 'pg';
import OpenAI from 'openai';
import type { MindmapGraph, MindmapNode, MindmapEdge } from './types';

const TOPIC_COLORS = [
  '#3b82f6', '#22c55e', '#f97316', '#a855f7',
  '#06b6d4', '#eab308', '#ec4899', '#14b8a6',
];

export class MindmapService {
  private pool: pg.Pool;
  private openai: OpenAI;

  constructor(pool: pg.Pool, openai: OpenAI) {
    this.pool = pool;
    this.openai = openai;
  }

  async getGraph(): Promise<MindmapGraph> {
    const { rows: topics } = await this.pool.query<{
      topic_id: number;
      label: string;
      message_count: number;
    }>(
      `SELECT m.topic_id, t.label, COUNT(m.id) as message_count
       FROM messages m
       LEFT JOIN topics t ON m.topic_id = t.id
       WHERE m.topic_id IS NOT NULL
       GROUP BY m.topic_id, t.label
       ORDER BY COUNT(m.id) DESC`,
    );

    if (topics.length === 0) {
      return { nodes: [], edges: [], updatedAt: new Date().toISOString() };
    }

    const nodes: MindmapNode[] = [{ id: 'center', type: 'center', data: { label: 'All Topics' } }];
    const edges: MindmapEdge[] = [];

    for (let i = 0; i < topics.length; i++) {
      const topic = topics[i]!;
      const topicNodeId = `topic-${topic.topic_id}`;
      const color = TOPIC_COLORS[i % TOPIC_COLORS.length];

      nodes.push({
        id: topicNodeId,
        type: 'topic',
        data: {
          label: `${topic.label} (${topic.message_count})`,
          color,
        },
      });
      edges.push({
        id: `e-center-${topic.topic_id}`,
        source: 'center',
        target: topicNodeId,
      });

      // Get recent messages for this topic to extract facts
      const { rows: messages } = await this.pool.query<{ content: string }>(
        `SELECT content FROM messages
         WHERE topic_id = $1
         ORDER BY id DESC
         LIMIT 3`,
        [topic.topic_id],
      );

      const facts = await this._extractFacts(messages.map(m => m.content));
      facts.forEach((fact, fi) => {
        const factId = `fact-${topic.topic_id}-${fi}`;
        nodes.push({ id: factId, type: 'fact', data: { label: fact } });
        edges.push({ id: `e-${topic.topic_id}-f${fi}`, source: topicNodeId, target: factId });
      });
    }

    return { nodes, edges, updatedAt: new Date().toISOString() };
  }

  private async _extractFacts(excerpts: string[]): Promise<string[]> {
    if (excerpts.length === 0) return [];

    try {
      const res = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content: `Extract up to 3 key facts from these excerpts (each under 8 words). Reply as JSON: {"facts":["..."]}\n\n${excerpts.join('\n\n')}`,
        }],
        response_format: { type: 'json_object' },
      });
      const raw = res.choices[0]?.message.content ?? '{}';
      const parsed = JSON.parse(raw) as { facts?: string[] };
      return Array.isArray(parsed.facts)
        ? parsed.facts.filter((f): f is string => typeof f === 'string').slice(0, 3)
        : [];
    } catch {
      return [];
    }
  }
}
