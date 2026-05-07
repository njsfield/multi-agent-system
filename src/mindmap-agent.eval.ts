import path from "path";
import { config } from "dotenv";
import { OpenAIAgent } from "./openai-agent";
import { FunctionTool } from "./tool";
import { MINDMAP_INSTRUCTIONS } from "./mindmap-agent";
import { LLMJudge, runEval } from "./eval-utils";
import type { MindmapGraph } from "./types";

config({ path: path.join(__dirname, "../.env") });

// ---------------------------------------------------------------------------
// Scenario definition
// ---------------------------------------------------------------------------

interface TopicRow { topicId: number; label: string; messageCount: number }
interface SubtopicRow { subtopic: string; messageCount: number }

interface MindmapScenario {
  id: string;
  description: string;
  expectedBehavior: string;
  mockTopics: TopicRow[];
  mockSubtopics: Record<number, SubtopicRow[]>;
  mockMessages: Record<number, string[]>;
}

// ---------------------------------------------------------------------------
// Eval agent factory — uses mock tools
// ---------------------------------------------------------------------------

function createEvalAgent(scenario: MindmapScenario): {
  agent: OpenAIAgent;
  getGraph: () => MindmapGraph | null;
} {
  const state = { graph: null as MindmapGraph | null };

  const getTopics = new FunctionTool(
    async () => JSON.stringify(scenario.mockTopics),
    "get_topics",
    "Get all topics with message counts.",
    { type: "object", properties: {}, required: [] },
  );

  const getSubtopics = new FunctionTool(
    async (params) => {
      const topicId = Number(params["topic_id"]);
      return JSON.stringify(scenario.mockSubtopics[topicId] ?? []);
    },
    "get_subtopics",
    "Get subtopics for a topic.",
    {
      type: "object",
      properties: { topic_id: { type: "number" } },
      required: ["topic_id"],
    },
  );

  const getRecentMessages = new FunctionTool(
    async (params) => {
      const topicId = Number(params["topic_id"]);
      return JSON.stringify(scenario.mockMessages[topicId] ?? []);
    },
    "get_recent_messages",
    "Get recent messages for a topic.",
    {
      type: "object",
      properties: {
        topic_id: { type: "number" },
        limit: { type: "number" },
      },
      required: ["topic_id"],
    },
  );

  const saveGraph = new FunctionTool(
    (params) => {
      state.graph = {
        nodes: params["nodes"] as MindmapGraph["nodes"],
        edges: params["edges"] as MindmapGraph["edges"],
        updatedAt: new Date().toISOString(),
      };
      return JSON.stringify({ success: true });
    },
    "save_graph",
    "Save the completed mindmap graph.",
    {
      type: "object",
      properties: {
        nodes: { type: "array" },
        edges: { type: "array" },
      },
      required: ["nodes", "edges"],
    },
  );

  const agent = new OpenAIAgent("mindmap-eval-agent", MINDMAP_INSTRUCTIONS, {
    tools: [getTopics, getSubtopics, getRecentMessages, saveGraph],
    streamTokens: false,
    maxIterations: 30,
  });

  return { agent, getGraph: () => state.graph };
}

// ---------------------------------------------------------------------------
// Judges
// ---------------------------------------------------------------------------

class StructureJudge extends LLMJudge {
  criteriaPrompt =
    "Evaluate whether the agent produced a valid MindmapGraph with: a center node, all topics as topic nodes, correct subtopic or fact nodes, and matching edges. Score 0 if save_graph was never called or the schema is invalid.";
}

class CompletenessJudge extends LLMJudge {
  criteriaPrompt =
    "Evaluate whether all topics from get_topics appear in the graph, and whether subtopics or facts are present for each topic as appropriate. Score based on how complete and accurate the coverage is.";
}

class MetadataJudge extends LLMJudge {
  criteriaPrompt =
    "Evaluate whether topic nodes include correct metadata: topicId (number), topicLabel (string), and color. Evaluate whether subtopic nodes include topicId and subtopic fields. Score 0 if these fields are missing.";
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const scenarios: MindmapScenario[] = [
  {
    id: "single-topic-subtopics",
    description: "One topic with two subtopics",
    expectedBehavior:
      "Graph has center → topic-1, topic-1 → subtopic-1-0 and subtopic-1-1. Topic node has topicId=1, subtopic nodes have topicId and subtopic fields.",
    mockTopics: [{ topicId: 1, label: "Fitness", messageCount: 5 }],
    mockSubtopics: {
      1: [
        { subtopic: "cardio training", messageCount: 3 },
        { subtopic: "nutrition", messageCount: 2 },
      ],
    },
    mockMessages: {},
  },
  {
    id: "topic-no-subtopics",
    description: "One topic with no subtopics — facts should be extracted from messages",
    expectedBehavior:
      "Graph has center → topic-1, and topic-1 connected to fact nodes derived from the message content.",
    mockTopics: [{ topicId: 1, label: "History", messageCount: 3 }],
    mockSubtopics: { 1: [] },
    mockMessages: {
      1: [
        "Napoleon was exiled to Elba in 1814.",
        "The Battle of Waterloo ended Napoleon's rule in 1815.",
        "Napoleon was born in Corsica in 1769.",
      ],
    },
  },
  {
    id: "multi-topic",
    description: "Three topics, each with one subtopic",
    expectedBehavior:
      "Graph includes all three topics with distinct colors, each connected to its subtopic. All edges are present.",
    mockTopics: [
      { topicId: 1, label: "Fitness", messageCount: 4 },
      { topicId: 2, label: "Finance", messageCount: 3 },
      { topicId: 3, label: "History", messageCount: 2 },
    ],
    mockSubtopics: {
      1: [{ subtopic: "strength training", messageCount: 4 }],
      2: [{ subtopic: "investing", messageCount: 3 }],
      3: [{ subtopic: "world war 2", messageCount: 2 }],
    },
    mockMessages: {},
  },
  {
    id: "no-topics",
    description: "No topics in the database — conversation history is empty",
    expectedBehavior:
      "Agent calls get_topics, receives empty array, and calls save_graph with an empty nodes/edges graph (or minimal graph with only the center node).",
    mockTopics: [],
    mockSubtopics: {},
    mockMessages: {},
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await runEval({
    agentName: "MindmapAgent",
    scenarios,
    judges: [new StructureJudge(), new CompletenessJudge(), new MetadataJudge()],
    run: async (scenario) => {
      const { agent, getGraph } = createEvalAgent(scenario);
      await agent.run("Build the current mindmap graph from conversation data.");
      const graph = getGraph();
      return graph ? JSON.stringify(graph) : "(no graph produced)";
    },
    buildContext: (scenario) =>
      `Scenario: ${scenario.description}\nExpected: ${scenario.expectedBehavior}\nMock topics: ${JSON.stringify(scenario.mockTopics)}\nMock subtopics: ${JSON.stringify(scenario.mockSubtopics)}`,
    outputDir: __dirname,
  });
}

main().catch(console.error);
