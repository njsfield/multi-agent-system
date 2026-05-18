import path from "path";
import { config } from "dotenv";
import OpenAI from "openai";
import { OpenAIAgent } from "./openai-agent";
import { LoggingMiddleware } from "./middleware";
import { FunctionTool } from "./tool";
import { createAgentServer } from "./server";
import { PgVectorMemory, createPgPool } from "./pg-memory";
import { ListMemory } from "./memory";
import type { BaseMemory } from "./memory";
import type { HistoryMessage, MindmapGraph } from "./types";
import { FlashcardAgent } from "./flashcard-agent";
import { MindmapMcpClient } from "./mcp-client";
import { webSearchTool } from "./web-search-tool";

config({ path: path.join(__dirname, "../.env") });

const PORT = 3000;

async function startServer() {
  let agentMemory: BaseMemory = new ListMemory();
  let getHistory: ((limit: number) => Promise<HistoryMessage[]>) | undefined;
  let flashcardAgent: FlashcardAgent | undefined;
  let getMindmap: (() => Promise<MindmapGraph>) | undefined;
  let getTopics: (() => Promise<import("./types").TopicTree[]>) | undefined;
  let mindmapClient: MindmapMcpClient | undefined;

  try {
    const DATABASE_URL =
      process.env["DATABASE_URL"] ?? "postgresql://localhost/tsagent";
    const openaiClient = new OpenAI({ apiKey: process.env["OPENAI_API_KEY"] });

    const pool = createPgPool(DATABASE_URL);
    await pool.query("SELECT 1");

    const pgMemory = new PgVectorMemory(pool, openaiClient);
    agentMemory = pgMemory;
    getHistory = (limit) => pgMemory.getHistory(limit);
    flashcardAgent = new FlashcardAgent(pool, openaiClient);
    getTopics = () => flashcardAgent!.getTopicsWithSubtopics();

    mindmapClient = new MindmapMcpClient();
    await mindmapClient.connect();
    getMindmap = () => mindmapClient!.getMindmap();

    console.log("[startup] postgres + mcp mindmap server: connected");
  } catch (err) {
    console.warn(
      "[startup] postgres or mcp unavailable, falling back to in-memory:",
      err,
    );
  }

  // Tool: chat agent fetches a topic summary via the mindmap MCP server.
  const getMindmapTool = new FunctionTool(
    async () => {
      if (!getMindmap) return JSON.stringify({ error: "Mindmap unavailable" });
      try {
        const graph = await getMindmap();
        const topics = graph.nodes
          .filter((n) => n.type === "topic")
          .map((n) => n.data?.label ?? "");
        return JSON.stringify({ topics, nodeCount: graph.nodes.length });
      } catch (err) {
        return JSON.stringify({ error: String(err) });
      }
    },
    "get_mindmap",
    "Fetch a summary of topics discussed in the conversation. Useful when the user asks what's been discussed or what they've been learning about.",
    { type: "object", properties: {}, required: [] },
  );

  function createChatAgent(): OpenAIAgent {
    return new OpenAIAgent(
      "chat-agent",
      "You are a helpful AI assistant. Answer questions conversationally and provide useful information. When the user asks you to look something up online, call web_search with a search query — it returns real page content from the top results in a single call, so synthesize that content directly into your answer. When the user asks about previous topics or what's been discussed, use the get_mindmap tool to see the conversation's topic structure.",
      {
        memory: agentMemory,
        tools: [getMindmapTool, webSearchTool],
        middleware: [new LoggingMiddleware()],
        streamTokens: true,
      },
    );
  }

  const app = createAgentServer(
    async function* (message, signal) {
      let lastAssistantContent = "";
      for await (const item of createChatAgent().runStream(message, signal)) {
        const obj = item as unknown as Record<string, unknown>;
        if (obj["role"] === "assistant" && typeof obj["content"] === "string") {
          lastAssistantContent = obj["content"];
        }
        yield item;
      }
      if (flashcardAgent) {
        flashcardAgent
          .extract(message, lastAssistantContent)
          .catch(console.error);
      }
    },
    {
      staticDir: path.join(__dirname, "../dist/ui"),
      getHistory,
      flashcardAgent,
      getMindmap,
      getTopics,
    },
  );

  app.listen(PORT, () => {
    console.log(`\nChat agent → http://localhost:${PORT}\n`);
  });

  const shutdown = async () => {
    await mindmapClient?.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

startServer().catch(console.error);
