import pg from "pg";
import { OpenAIAgent } from "./openai-agent";
import { FunctionTool } from "./tool";
import { OtelMiddleware } from "./otel-middleware";
import type { MindmapGraph, MindmapNode, MindmapEdge } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOPIC_COLORS = [
  "#3b82f6", "#22c55e", "#f97316", "#a855f7",
  "#06b6d4", "#eab308", "#ec4899", "#14b8a6",
];

// ---------------------------------------------------------------------------
// Deterministic graph builder — called from the build_graph tool
// ---------------------------------------------------------------------------

interface TopicRow { topicId: number; label: string; messageCount: number }
interface SubtopicRow { subtopic: string; messageCount: number }

function buildGraphFromData(
  topics: TopicRow[],
  subtopicsPerTopic: Record<string, SubtopicRow[]>,
  factsPerTopic: Record<string, string[]>,
): MindmapGraph {
  const nodes: MindmapNode[] = [];
  const edges: MindmapEdge[] = [];

  nodes.push({ id: "center", type: "center", data: { label: "All Topics" } });

  topics.forEach((topic, i) => {
    const topicNodeId = `topic-${topic.topicId}`;
    const color = TOPIC_COLORS[i % TOPIC_COLORS.length]!;

    nodes.push({
      id: topicNodeId,
      type: "topic",
      data: {
        label: `${topic.label} (${topic.messageCount})`,
        color,
        topicId: topic.topicId,
        topicLabel: topic.label,
      },
    });
    edges.push({ id: `e-center-${topic.topicId}`, source: "center", target: topicNodeId });

    const subtopics = subtopicsPerTopic[String(topic.topicId)] ?? [];
    if (subtopics.length > 0) {
      subtopics.forEach((sub, si) => {
        const subId = `subtopic-${topic.topicId}-${si}`;
        nodes.push({
          id: subId,
          type: "subtopic",
          data: { label: sub.subtopic, topicId: topic.topicId, subtopic: sub.subtopic },
        });
        edges.push({ id: `e-${topic.topicId}-s${si}`, source: topicNodeId, target: subId });
      });
    } else {
      const facts = factsPerTopic[String(topic.topicId)] ?? [];
      facts.forEach((fact, fi) => {
        const factId = `fact-${topic.topicId}-${fi}`;
        nodes.push({ id: factId, type: "fact", data: { label: fact } });
        edges.push({ id: `e-${topic.topicId}-f${fi}`, source: topicNodeId, target: factId });
      });
    }
  });

  return { nodes, edges, updatedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Agent instructions
// ---------------------------------------------------------------------------

export const MINDMAP_INSTRUCTIONS = `You are a mindmap data collector. Your job is to gather conversation data and assemble it for graph rendering.

Steps:
1. Call get_topics to retrieve all topics.
2. For each topic, call get_subtopics with its topicId.
3. For any topic that has NO subtopics (empty array), call get_recent_messages for that topic and extract up to 3 short key facts (each under 8 words) from the message content.
4. Call build_graph with all the data you have collected:
   - topics: the array returned by get_topics
   - subtopicsPerTopic: an object mapping each topicId (as string key) to the array from get_subtopics
   - factsPerTopic: an object mapping each topicId (as string key) to the array of extracted facts (only for topics that had no subtopics)

Always call build_graph as your final step, even if there are no topics.`;

// ---------------------------------------------------------------------------
// Tool factories
// ---------------------------------------------------------------------------

function buildMindmapTools(
  pool: pg.Pool,
  state: { graph: MindmapGraph | null },
): FunctionTool[] {
  const getTopics = new FunctionTool(
    async () => {
      try {
        const { rows } = await pool.query<{
          topic_id: number;
          label: string;
          message_count: string;
        }>(
          `SELECT m.topic_id, t.label, COUNT(m.id) AS message_count
           FROM messages m
           LEFT JOIN topics t ON m.topic_id = t.id
           WHERE m.topic_id IS NOT NULL
           GROUP BY m.topic_id, t.label
           ORDER BY COUNT(m.id) DESC`,
        );
        return JSON.stringify(
          rows.map((r) => ({
            topicId: r.topic_id,
            label: r.label,
            messageCount: Number(r.message_count),
          })),
        );
      } catch (err) {
        return JSON.stringify({ error: String(err) });
      }
    },
    "get_topics",
    "Get all topics that have been discussed, with message counts. Returns [{topicId, label, messageCount}].",
    { type: "object", properties: {}, required: [] },
  );

  const getSubtopics = new FunctionTool(
    async (params) => {
      const topicId = Number(params["topic_id"]);
      if (isNaN(topicId)) return JSON.stringify({ error: "topic_id required" });
      try {
        const { rows } = await pool.query<{ subtopic: string; message_count: string }>(
          `SELECT subtopic, COUNT(*) AS message_count
           FROM messages
           WHERE topic_id = $1 AND subtopic IS NOT NULL
           GROUP BY subtopic
           ORDER BY COUNT(*) DESC
           LIMIT 5`,
          [topicId],
        );
        return JSON.stringify(
          rows.map((r) => ({ subtopic: r.subtopic, messageCount: Number(r.message_count) })),
        );
      } catch (err) {
        return JSON.stringify({ error: String(err) });
      }
    },
    "get_subtopics",
    "Get subtopics for a topic. Returns [{subtopic, messageCount}]. Empty array means no subtopics yet.",
    {
      type: "object",
      properties: {
        topic_id: { type: "number", description: "Topic ID to fetch subtopics for" },
      },
      required: ["topic_id"],
    },
  );

  const getRecentMessages = new FunctionTool(
    async (params) => {
      const topicId = Number(params["topic_id"]);
      const limit = Math.min(Number(params["limit"] ?? 3), 5);
      if (isNaN(topicId)) return JSON.stringify({ error: "topic_id required" });
      try {
        const { rows } = await pool.query<{ content: string }>(
          `SELECT content FROM messages WHERE topic_id = $1 ORDER BY id DESC LIMIT $2`,
          [topicId, limit],
        );
        return JSON.stringify(rows.map((r) => r.content));
      } catch (err) {
        return JSON.stringify({ error: String(err) });
      }
    },
    "get_recent_messages",
    "Get recent message content for a topic. Use this to extract facts when a topic has no subtopics.",
    {
      type: "object",
      properties: {
        topic_id: { type: "number" },
        limit: { type: "number", description: "Max messages (default 3, max 5)" },
      },
      required: ["topic_id"],
    },
  );

  const buildGraph = new FunctionTool(
    (params) => {
      const topics = (params["topics"] as TopicRow[]) ?? [];
      const subtopicsPerTopic = (params["subtopicsPerTopic"] as Record<string, SubtopicRow[]>) ?? {};
      const factsPerTopic = (params["factsPerTopic"] as Record<string, string[]>) ?? {};
      state.graph = buildGraphFromData(topics, subtopicsPerTopic, factsPerTopic);
      return JSON.stringify({ success: true, nodeCount: state.graph.nodes.length });
    },
    "build_graph",
    "Assemble the final mindmap graph from collected data. The graph structure is built deterministically from the inputs you provide.",
    {
      type: "object",
      properties: {
        topics: {
          type: "array",
          description: "Array of {topicId, label, messageCount} from get_topics",
          items: { type: "object" },
        },
        subtopicsPerTopic: {
          type: "object",
          description: "Object mapping topicId string → [{subtopic, messageCount}] from get_subtopics calls",
        },
        factsPerTopic: {
          type: "object",
          description: "Object mapping topicId string → string[] of short facts (only for topics with no subtopics)",
        },
      },
      required: ["topics", "subtopicsPerTopic", "factsPerTopic"],
    },
  );

  return [getTopics, getSubtopics, getRecentMessages, buildGraph];
}

// ---------------------------------------------------------------------------
// MindmapAgent
// ---------------------------------------------------------------------------

export class MindmapAgent extends OpenAIAgent {
  private _state: { graph: MindmapGraph | null };

  constructor(pool: pg.Pool) {
    const state = { graph: null as MindmapGraph | null };

    super("mindmap-agent", MINDMAP_INSTRUCTIONS, {
      tools: buildMindmapTools(pool, state),
      middleware: [new OtelMiddleware("mindmap-agent")],
      streamTokens: false,
      maxIterations: 30,
    });

    this._state = state;
  }

  async getGraph(): Promise<MindmapGraph> {
    this.context.messages = [];
    this._state.graph = null;

    await this.run("Build the current mindmap graph from conversation data.");

    return this._state.graph ?? { nodes: [], edges: [], updatedAt: new Date().toISOString() };
  }
}
