import path from 'path';
import { config } from 'dotenv';
import { OpenAIAgent } from './openai-agent';
import { LoggingMiddleware } from './middleware';
import { createAgentServer } from './server';
import OpenAI from 'openai';
import { PgVectorMemory, createPgPool } from './pg-memory';
import { MindmapService } from './mindmap';
import { ListMemory } from './memory';
import type { BaseMemory } from './memory';
import type { HistoryMessage } from './types';
import { FlashcardService } from './flashcard-service';
import { FlashcardExtractor } from './flashcard-extractor';
import { createFlashcardSelectionAgent } from './flashcard-agent';
import type { FlashcardCard } from './flashcard-service';

config({ path: path.join(__dirname, '../.env') });

const PORT = 3000;

async function startServer() {
  let agentMemory: BaseMemory;
  let getHistory: ((limit: number) => Promise<HistoryMessage[]>) | undefined;
  let getFlashcard: (() => Promise<FlashcardCard | null>) | undefined;
  let reviewFlashcard:
    | ((id: number, score: string) => Promise<Date>)
    | undefined;
  let flashcardExtractor: FlashcardExtractor | undefined;
  let mindmapService: MindmapService | undefined;

  const DATABASE_URL =
    process.env['DATABASE_URL'] ?? 'postgresql://localhost/tsagent';
  const openaiClient = new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] });

  try {
    const pool = createPgPool(DATABASE_URL);
    await pool.query('SELECT 1'); // connection test
    const pgMemory = new PgVectorMemory(pool, openaiClient);
    agentMemory = pgMemory;
    getHistory = (limit) => pgMemory.getHistory(limit);

    const flashcardService = new FlashcardService(pool);
    const flashcardAgent = createFlashcardSelectionAgent(pool);
    flashcardExtractor = new FlashcardExtractor(pool, openaiClient);

    getFlashcard = async () => {
      const response = await flashcardAgent.run(
        'Select a flashcard for review.',
      );
      const lastMsg = response.messages.at(-1);
      if (!lastMsg) return null;
      try {
        const parsed = JSON.parse(lastMsg.content) as { id?: number | null };
        if (!parsed.id) return null;
        return flashcardService.getById(parsed.id);
      } catch {
        const match = lastMsg.content.match(/"id"\s*:\s*(\d+)/);
        if (!match) return null;
        return flashcardService.getById(parseInt(match[1]!, 10));
      }
    };

    reviewFlashcard = (id: number, score: string) =>
      flashcardService.applyReview(id, score);

    mindmapService = new MindmapService(pool, openaiClient);
    console.log('[startup] postgres memory: connected');
  } catch (err) {
    console.warn(
      '[startup] postgres unavailable, falling back to in-memory:',
      err,
    );
    agentMemory = new ListMemory();
  }

  function createChatAgent(): OpenAIAgent {
    return new OpenAIAgent(
      'chat-agent',
      `You are a helpful AI assistant. Answer questions conversationally and provide useful information. Be friendly, clear, and concise.`,
      {
        memory: agentMemory,
        middleware: [new LoggingMiddleware()],
        streamTokens: true,
      },
    );
  }

  const app = createAgentServer(
    async function* (message, signal) {
      let lastAssistantContent = '';
      for await (const item of createChatAgent().runStream(
        message,
        signal,
      )) {
        const obj = item as unknown as Record<string, unknown>;
        if (obj['role'] === 'assistant' && typeof obj['content'] === 'string') {
          lastAssistantContent = obj['content'];
        }
        yield item;
      }
      if (flashcardExtractor) {
        flashcardExtractor
          .extract(message, lastAssistantContent)
          .catch(console.error);
      }
    },
    {
      staticDir: path.join(__dirname, '../dist/ui'),
      getHistory,
      getFlashcard,
      reviewFlashcard,
      getMindmap: mindmapService ? () => mindmapService!.getGraph() : undefined,
    },
  );

  app.listen(PORT, () => {
    console.log(`\nChat agent → http://localhost:${PORT}\n`);
    console.log(`  curl -sN -X POST http://localhost:${PORT}/chat \\`);
    console.log(`    -H 'Content-Type: application/json' \\`);
    console.log(
      `    -d '{"message": "Hello, how can you help me?"}'`,
    );
    console.log('');
  });
}

startServer().catch(console.error);
