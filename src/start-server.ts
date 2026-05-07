import path from "path";
import { config } from "dotenv";
import OpenAI from "openai";
import { OpenAIAgent } from "./openai-agent";
import { LoggingMiddleware } from "./middleware";
import { createAgentServer } from "./server";
import { PgVectorMemory, createPgPool } from "./pg-memory";
import { ListMemory } from "./memory";
import type { BaseMemory } from "./memory";
import type { HistoryMessage } from "./types";
import { FlashcardAgent } from "./flashcard-agent";
import { MindmapAgent } from "./mindmap-agent";

config({ path: path.join(__dirname, "../.env") });

const PORT = 3000;

async function startServer() {
  let agentMemory: BaseMemory = new ListMemory();
  let getHistory: ((limit: number) => Promise<HistoryMessage[]>) | undefined;
  let flashcardAgent: FlashcardAgent | undefined;
  let mindmapAgent: MindmapAgent | undefined;

  try {
    const DATABASE_URL =
      process.env["DATABASE_URL"] ?? "postgresql://localhost/tsagent";
    const openaiClient = new OpenAI({ apiKey: process.env["OPENAI_API_KEY"] });

    const pool = createPgPool(DATABASE_URL);
    await pool.query("SELECT 1");

    const pgMemory = new PgVectorMemory(pool, openaiClient);
    agentMemory = pgMemory;
    getHistory = (limit) => pgMemory.getHistory(limit);
    flashcardAgent = new FlashcardAgent(pool);
    mindmapAgent = new MindmapAgent(pool);

    console.log("[startup] postgres: connected");
  } catch (err) {
    console.warn(
      "[startup] postgres unavailable, falling back to in-memory:",
      err,
    );
  }

  function createChatAgent(): OpenAIAgent {
    return new OpenAIAgent(
      "chat-agent",
      "You are a helpful AI assistant. Answer questions conversationally and provide useful information. Be friendly, clear, and concise.",
      {
        memory: agentMemory,
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
        flashcardAgent.extract(message, lastAssistantContent).catch(console.error);
      }
    },
    {
      staticDir: path.join(__dirname, "../dist/ui"),
      getHistory,
      flashcardAgent,
      mindmapAgent,
    },
  );

  app.listen(PORT, () => {
    console.log(`\nChat agent → http://localhost:${PORT}\n`);
  });
}

startServer().catch(console.error);
