# pgvector Memory, Conversation History, and Thinking Indicator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist all conversation turns to postgres with pgvector semantic search, expose a `/history` endpoint that seeds the UI with the last 50 messages on load, and show "Thinking…" in the assistant bubble while waiting for the first token.

**Architecture:** A new `PgVectorMemory` class (implements `BaseMemory`) owns all postgres I/O — writing messages + embeddings on each completed exchange, serving semantic search via cosine similarity, and returning ordered history for the endpoint. The `Agent` class wires memory at the start (context injection into system message) and end (persistence) of each turn. The UI fetches history on mount and tracks an `isThinking` flag per message.

**Tech Stack:** Node.js/TypeScript, Express, `pg` (postgres client), OpenAI `text-embedding-3-small`, pgvector, React 19, Vite, vitest

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `schema.sql` | Create | Postgres DDL (messages + message_embeddings tables) |
| `src/pg-memory.ts` | Create | `PgVectorMemory` class + `createPgPool` helper |
| `src/pg-memory.test.ts` | Create | Unit tests for `PgVectorMemory` |
| `src/agent.test.ts` | Create | Unit tests for memory wiring in `Agent` |
| `src/memory.ts` | Modify | Change `add()` return type to `Promise<void>` |
| `src/agent.ts` | Modify | Wire `memory.getContext/query` into system message; call `memory.add` after final message |
| `src/types.ts` | Modify | Add `HistoryMessage` interface |
| `src/server.ts` | Modify | Add `GET /history` endpoint + `getHistory` option; allow GET in CORS |
| `vitest.config.ts` | Create | Vitest config for Node.js environment |
| `vite.config.ts` | Modify | Proxy `/history` to backend |
| `examples/api-server.ts` | Modify | Create `pg.Pool` + `PgVectorMemory`; wire into server and agent |
| `src/ui/hooks/useChat.ts` | Modify | Add `isThinking` to `UIMessage`; history hydration on mount |
| `src/ui/components/Message.tsx` | Modify | Render "Thinking…" when `isThinking` is true |

---

## Task 1: Schema + dependencies + test infrastructure

**Files:**
- Create: `schema.sql`
- Create: `vitest.config.ts`
- Modify: `package.json` (add scripts + deps)

- [ ] **Step 1: Create `schema.sql`**

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE messages (
  id         BIGSERIAL PRIMARY KEY,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  source     TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE message_embeddings (
  id         BIGSERIAL PRIMARY KEY,
  message_id BIGINT REFERENCES messages(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  embedding  VECTOR(1536),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON message_embeddings USING hnsw (embedding vector_cosine_ops);
```

- [ ] **Step 2: Run the schema against your local postgres**

```bash
psql $DATABASE_URL -f schema.sql
# Expected: CREATE EXTENSION, CREATE TABLE (x2), CREATE INDEX
```

If `DATABASE_URL` is not set, substitute your connection string, e.g. `postgresql://localhost/tsagent`.

- [ ] **Step 3: Install `pg`, `@types/pg`, and `vitest`**

```bash
yarn add pg && yarn add -D @types/pg vitest
```

- [ ] **Step 4: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 5: Add test script to `package.json`**

In the `"scripts"` block, add:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 6: Verify vitest works**

```bash
yarn test
# Expected: "No test files found" — no failures
```

- [ ] **Step 7: Commit**

```bash
git add schema.sql vitest.config.ts package.json yarn.lock
git commit -m "feat: add postgres schema, pg dep, and vitest"
```

---

## Task 2: `PgVectorMemory` — TDD

**Files:**
- Create: `src/pg-memory.test.ts`
- Create: `src/pg-memory.ts`

- [ ] **Step 1: Add `HistoryMessage` to `src/types.ts`**

`pg-memory.ts` imports this type, so it must exist before the file is created. Append to the end of `src/types.ts`:

```typescript
export interface HistoryMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  source: string;
  contentType: 'text' | 'markdown';
  createdAt: string;
}
```

- [ ] **Step 2: Write failing tests in `src/pg-memory.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgVectorMemory } from './pg-memory';
import type pg from 'pg';
import type OpenAI from 'openai';

const fakeEmbedding = new Array(1536).fill(0.1);

function makePool(queryImpl: ReturnType<typeof vi.fn> = vi.fn()) {
  return { query: queryImpl } as unknown as pg.Pool;
}

function makeOpenAI(embedding = fakeEmbedding) {
  return {
    embeddings: {
      create: vi.fn().mockResolvedValue({ data: [{ embedding }] }),
    },
  } as unknown as OpenAI;
}

describe('PgVectorMemory', () => {
  describe('add', () => {
    it('inserts into messages and message_embeddings', async () => {
      const query = vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: 1 }] })
        .mockResolvedValueOnce({ rows: [] });
      const openai = makeOpenAI();
      const memory = new PgVectorMemory(makePool(query), openai);

      await memory.add('hello world', { role: 'user', source: 'user' });

      expect(query).toHaveBeenCalledTimes(2);
      expect(query).toHaveBeenNthCalledWith(
        1,
        'INSERT INTO messages (role, content, source) VALUES ($1, $2, $3) RETURNING id',
        ['user', 'hello world', 'user'],
      );
      expect(openai.embeddings.create).toHaveBeenCalledWith({
        model: 'text-embedding-3-small',
        input: 'hello world',
      });
    });

    it('still persists to messages when embedding fails', async () => {
      const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: 1 }] });
      const openai = {
        embeddings: { create: vi.fn().mockRejectedValue(new Error('API error')) },
      } as unknown as OpenAI;
      const memory = new PgVectorMemory(makePool(query), openai);

      await memory.add('hello', { role: 'user', source: 'user' });

      expect(query).toHaveBeenCalledTimes(1);
    });
  });

  describe('query', () => {
    it('returns role-prefixed content strings from cosine similarity search', async () => {
      const query = vi.fn().mockResolvedValue({
        rows: [{ role: 'assistant', content: 'sunny in Tokyo' }],
      });
      const openai = makeOpenAI();
      const memory = new PgVectorMemory(makePool(query), openai);

      const results = await memory.query('weather in Tokyo', 3);

      expect(results).toEqual(['assistant: sunny in Tokyo']);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('ORDER BY me.embedding <=>'),
        [JSON.stringify(fakeEmbedding), 3],
      );
    });
  });

  describe('getContext', () => {
    it('returns recent messages as "role: content" strings, oldest first', async () => {
      const query = vi.fn().mockResolvedValue({
        rows: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi there' },
        ],
      });
      const memory = new PgVectorMemory(makePool(query), makeOpenAI());

      const results = await memory.getContext(10);

      expect(results).toEqual(['user: hello', 'assistant: hi there']);
    });
  });

  describe('getHistory', () => {
    it('returns history with contentType derived from content', async () => {
      const query = vi.fn().mockResolvedValue({
        rows: [
          { id: 1, role: 'user', content: 'hello', source: 'user', created_at: '2026-04-30T00:00:00Z' },
          { id: 2, role: 'assistant', content: '## Response\nHi!', source: 'agent', created_at: '2026-04-30T00:00:01Z' },
        ],
      });
      const memory = new PgVectorMemory(makePool(query), makeOpenAI());

      const results = await memory.getHistory(50);

      expect(results).toEqual([
        { id: 1, role: 'user', content: 'hello', source: 'user', contentType: 'text', createdAt: '2026-04-30T00:00:00Z' },
        { id: 2, role: 'assistant', content: '## Response\nHi!', source: 'agent', contentType: 'markdown', createdAt: '2026-04-30T00:00:01Z' },
      ]);
    });
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
yarn test
# Expected: FAIL — "Cannot find module './pg-memory'"
```

- [ ] **Step 3: Create `src/pg-memory.ts`**

```typescript
import pg from 'pg';
import OpenAI from 'openai';
import { BaseMemory } from './memory';
import type { HistoryMessage } from './types';

function isMarkdown(text: string): boolean {
  return (
    /^#{1,6}\s/m.test(text) ||
    /^\s*[-*+]\s/m.test(text) ||
    /^\s*\d+\.\s/m.test(text) ||
    /`[^`]+`/.test(text) ||
    /^```/m.test(text) ||
    /\*\*[^*]+\*\*/.test(text) ||
    /^>\s/m.test(text)
  );
}

export function createPgPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString });
}

export class PgVectorMemory extends BaseMemory {
  private pool: pg.Pool;
  private openai: OpenAI;

  constructor(pool: pg.Pool, openai: OpenAI) {
    super();
    this.pool = pool;
    this.openai = openai;
  }

  async add(content: string, metadata: Record<string, unknown> = {}): Promise<void> {
    const role   = String(metadata['role']   ?? 'user');
    const source = String(metadata['source'] ?? 'unknown');

    const { rows } = await this.pool.query<{ id: number }>(
      'INSERT INTO messages (role, content, source) VALUES ($1, $2, $3) RETURNING id',
      [role, content, source],
    );
    const messageId = rows[0]!.id;

    try {
      const res = await this.openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: content,
      });
      const embedding = res.data[0]!.embedding;
      await this.pool.query(
        'INSERT INTO message_embeddings (message_id, content, embedding) VALUES ($1, $2, $3)',
        [messageId, content, JSON.stringify(embedding)],
      );
    } catch (err) {
      console.error('[PgVectorMemory] embedding failed, skipping vector insert:', err);
    }
  }

  async query(query: string, limit = 5): Promise<string[]> {
    const res = await this.openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: query,
    });
    const embedding = res.data[0]!.embedding;

    const { rows } = await this.pool.query<{ role: string; content: string }>(
      `SELECT m.role, me.content
       FROM message_embeddings me
       JOIN messages m ON m.id = me.message_id
       ORDER BY me.embedding <=> $1
       LIMIT $2`,
      [JSON.stringify(embedding), limit],
    );

    return rows.map(r => `${r.role}: ${r.content}`);
  }

  async getContext(maxItems = 20): Promise<string[]> {
    const { rows } = await this.pool.query<{ role: string; content: string }>(
      'SELECT role, content FROM messages ORDER BY id ASC LIMIT $1',
      [maxItems],
    );
    return rows.map(r => `${r.role}: ${r.content}`);
  }

  async getHistory(limit: number): Promise<HistoryMessage[]> {
    const { rows } = await this.pool.query<{
      id: number;
      role: string;
      content: string;
      source: string;
      created_at: string;
    }>(
      'SELECT id, role, content, source, created_at FROM messages ORDER BY id ASC LIMIT $1',
      [limit],
    );
    return rows.map(r => ({
      id:          r.id,
      role:        r.role as 'user' | 'assistant',
      content:     r.content,
      source:      r.source,
      contentType: isMarkdown(r.content) ? 'markdown' : 'text',
      createdAt:   r.created_at,
    }));
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
yarn test
# Expected: PASS — 6 tests
```

- [ ] **Step 5: Commit**

```bash
git add src/pg-memory.ts src/pg-memory.test.ts
git commit -m "feat: add PgVectorMemory with pgvector semantic search"
```

---

## Task 3: Update `BaseMemory.add()` to `Promise<void>`

**Files:**
- Modify: `src/memory.ts`

`Agent` will `await memory.add(...)`. TypeScript requires the abstract signature to match.

- [ ] **Step 1: Update `src/memory.ts`**

Replace:
```typescript
abstract add(content: string, metadata?: Record<string, unknown>): void;
```
With:
```typescript
abstract add(content: string, metadata?: Record<string, unknown>): Promise<void>;
```

Update `ListMemory.add()` to match:
```typescript
async add(content: string, metadata: Record<string, unknown> = {}): Promise<void> {
  this.memories.push({ content, metadata });
  if (this.memories.length > this.maxMemoryItems) {
    this.memories = this.memories.slice(-this.maxMemoryItems);
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
yarn typecheck
# Expected: no errors
```

- [ ] **Step 3: Commit**

```bash
git add src/memory.ts
git commit -m "refactor: make BaseMemory.add() return Promise<void>"
```

---

## Task 4: Wire memory into `Agent` — TDD

**Files:**
- Create: `src/agent.test.ts`
- Modify: `src/agent.ts`

- [ ] **Step 1: Write failing tests in `src/agent.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { Agent } from './agent';
import type { BaseChatClient } from './client';
import { BaseMemory } from './memory';

class TestMemory extends BaseMemory {
  getContextResult: string[] = [];
  queryResult: string[]      = [];
  addedItems: Array<{ content: string; metadata: Record<string, unknown> }> = [];

  async add(content: string, metadata: Record<string, unknown> = {}): Promise<void> {
    this.addedItems.push({ content, metadata });
  }
  async query(_q: string, _limit?: number): Promise<string[]>     { return this.queryResult; }
  async getContext(_max?: number):           Promise<string[]>     { return this.getContextResult; }
}

function makeClient(responseContent = 'test response'): BaseChatClient {
  return {
    create: vi.fn().mockResolvedValue({
      message: {
        role:      'assistant' as const,
        content:   responseContent,
        source:    'agent',
        timestamp: new Date(),
      },
    }),
    createStream: vi.fn(),
  } as unknown as BaseChatClient;
}

describe('Agent with memory', () => {
  it('injects recent context and relevant past context into system message', async () => {
    const memory = new TestMemory();
    memory.getContextResult = ['user: what is 2+2?', 'assistant: 4'];
    memory.queryResult      = ['assistant: I helped with math before'];

    const client = makeClient();
    const agent  = new Agent('test-agent', 'Be helpful.', client, [], memory);

    await agent.run('another question');

    const [messages] = (client.create as ReturnType<typeof vi.fn>).mock.calls[0] as [Array<{ content: string }>];
    const systemContent = messages[0]!.content;
    expect(systemContent).toContain('Recent conversation:');
    expect(systemContent).toContain('user: what is 2+2?');
    expect(systemContent).toContain('Relevant past context:');
    expect(systemContent).toContain('I helped with math before');
  });

  it('persists user and assistant messages after a completed turn', async () => {
    const memory = new TestMemory();
    const client = makeClient('sunny and warm');
    const agent  = new Agent('weather-agent', 'Be helpful.', client, [], memory);

    await agent.run('what is the weather?');

    expect(memory.addedItems).toHaveLength(2);
    expect(memory.addedItems[0]).toEqual({
      content:  'what is the weather?',
      metadata: { role: 'user', source: 'user' },
    });
    expect(memory.addedItems[1]).toEqual({
      content:  'sunny and warm',
      metadata: { role: 'assistant', source: 'weather-agent' },
    });
  });

  it('runs without error when memory is undefined', async () => {
    const client = makeClient();
    const agent  = new Agent('test-agent', 'Be helpful.', client);
    await expect(agent.run('question')).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
yarn test src/agent.test.ts
# Expected: FAIL — memory methods not called
```

- [ ] **Step 3: Update `src/agent.ts` — `run()` method**

Replace the `run()` method body up through the system message construction:

```typescript
async run(task: string | UserMessage | Message[]): Promise<AgentResponse> {
  const taskMessages = this.normalizeTask(task);
  const userContent  = taskMessages.find(m => m.role === 'user')?.content ?? '';

  let instructions = this.instructions;
  if (this.memory) {
    const [recentCtx, relevantCtx] = await Promise.all([
      this.memory.getContext(20),
      this.memory.query(userContent, 5),
    ]);
    if (recentCtx.length)   instructions += `\n\nRecent conversation:\n${recentCtx.join('\n')}`;
    if (relevantCtx.length) instructions += `\n\nRelevant past context:\n${relevantCtx.join('\n')}`;
  }

  const systemMessage: SystemMessage = {
    role:      'system',
    content:   instructions,
    source:    'system',
    timestamp: new Date(),
  };
  const llmMessages: Message[] = [systemMessage, ...this.context.messages, ...taskMessages];
  const tools    = this.getToolsForLLM();
  const responses: Message[] = [];

  for (let i = 0; i < this.maxIterations; i++) {
    const modelCtx = this.buildModelCtx(llmMessages);
    await this.middlewareChain.execute(modelCtx);
    let completionResult = await this.modelClient.create(llmMessages, tools);
    completionResult = (await this.middlewareChain.executeResponse(modelCtx, completionResult) as typeof completionResult) ?? completionResult;

    const assistantMessage = completionResult.message;
    llmMessages.push(assistantMessage);

    if (!assistantMessage.toolCalls?.length) {
      this.context.addMessage(assistantMessage);
      responses.push(assistantMessage);

      if (this.memory) {
        await this.memory.add(userContent,              { role: 'user',      source: 'user' });
        await this.memory.add(assistantMessage.content, { role: 'assistant', source: this.name });
      }
      break;
    }

    for (const toolCall of assistantMessage.toolCalls) {
      llmMessages.push(await this.runToolCall(toolCall));
    }
  }

  return { messages: responses };
}
```

- [ ] **Step 4: Update `src/agent.ts` — `runStream()` method**

Replace the `runStream()` method body up through the system message construction, and add persistence after the final yield:

```typescript
async *runStream(task: string | UserMessage | Message[], signal?: AbortSignal): AsyncGenerator<Message | AgentEvent | TokenChunk> {
  const taskMessages = this.normalizeTask(task);
  const userContent  = taskMessages.find(m => m.role === 'user')?.content ?? '';

  let instructions = this.instructions;
  if (this.memory) {
    const [recentCtx, relevantCtx] = await Promise.all([
      this.memory.getContext(20),
      this.memory.query(userContent, 5),
    ]);
    if (recentCtx.length)   instructions += `\n\nRecent conversation:\n${recentCtx.join('\n')}`;
    if (relevantCtx.length) instructions += `\n\nRelevant past context:\n${relevantCtx.join('\n')}`;
  }

  const systemMessage: SystemMessage = {
    role:      'system',
    content:   instructions,
    source:    'system',
    timestamp: new Date(),
  };
  const llmMessages: Message[] = [systemMessage, ...this.context.messages, ...taskMessages];
  const tools = this.getToolsForLLM();

  for (let i = 0; i < this.maxIterations; i++) {
    signal?.throwIfAborted();

    const modelCtx = this.buildModelCtx(llmMessages);
    await this.middlewareChain.execute(modelCtx);

    let completionResult: ChatCompletionResult;

    if (this.streamTokens) {
      let finalResult: ChatCompletionResult | undefined;

      for await (const item of this.modelClient.createStream(llmMessages, tools, signal)) {
        if ((item as TokenChunk).type === 'token') {
          yield item as TokenChunk;
        } else {
          finalResult = item as ChatCompletionResult;
        }
      }

      if (!finalResult) break;
      completionResult = (await this.middlewareChain.executeResponse(modelCtx, finalResult) as ChatCompletionResult) ?? finalResult;
    } else {
      let result = await this.modelClient.create(llmMessages, tools, signal);
      completionResult = (await this.middlewareChain.executeResponse(modelCtx, result) as typeof result) ?? result;
    }

    const assistantMessage = completionResult.message;
    const taggedMessage: Message = { ...assistantMessage, source: this.name };
    llmMessages.push(taggedMessage);

    if (!assistantMessage.toolCalls?.length) {
      this.context.addMessage(taggedMessage);
      yield taggedMessage;

      if (this.memory) {
        await this.memory.add(userContent,              { role: 'user',      source: 'user' });
        await this.memory.add(assistantMessage.content, { role: 'assistant', source: this.name });
      }
      break;
    }

    for (const toolCall of assistantMessage.toolCalls) {
      llmMessages.push(await this.runToolCall(toolCall));
    }
  }
}
```

- [ ] **Step 5: Run all tests**

```bash
yarn test
# Expected: PASS — all tests including the 3 new agent tests
```

- [ ] **Step 6: Typecheck**

```bash
yarn typecheck
# Expected: no errors
```

- [ ] **Step 7: Commit**

```bash
git add src/agent.ts src/agent.test.ts
git commit -m "feat: wire memory context injection and persistence into Agent"
```

---

## Task 5: `GET /history` endpoint

**Files:**
- Modify: `src/server.ts`
- Modify: `vite.config.ts`

(`HistoryMessage` was already added to `src/types.ts` in Task 2 Step 1.)

- [ ] **Step 1: Update `src/server.ts` — imports and types**

Add `HistoryMessage` to the import from `'./types'`:

```typescript
import { HistoryMessage } from './types';
```

Update `AgentServerOptions`:

```typescript
export interface AgentServerOptions {
  staticDir?: string;
  getHistory?: (limit: number) => Promise<HistoryMessage[]>;
}
```

- [ ] **Step 2: Update `src/server.ts` — CORS and `/history` route**

In the CORS middleware, update `Allow-Methods` to include GET:

```typescript
res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
```

Add the `OPTIONS /history` preflight handler immediately after the existing `OPTIONS /chat` handler:

```typescript
app.options('/history', (_req: Request, res: Response) => { res.sendStatus(204); });
```

Add the `GET /history` handler after the `POST /chat` handler (before the static file serving block):

```typescript
app.get('/history', async (req: Request, res: Response) => {
  if (!options.getHistory) {
    res.status(404).json({ error: 'History not configured' });
    return;
  }
  const limitParam = parseInt(String((req.query as Record<string, string>)['limit'] ?? '50'), 10);
  const limit = Math.min(Math.max(1, isNaN(limitParam) ? 50 : limitParam), 100);
  try {
    const messages = await options.getHistory(limit);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
```

- [ ] **Step 3: Update `vite.config.ts` — proxy `/history`**

Update the `proxy` block:

```typescript
proxy: {
  '/chat':    'http://localhost:3000',
  '/history': 'http://localhost:3000',
},
```

- [ ] **Step 4: Typecheck**

```bash
yarn typecheck
# Expected: no errors
```

- [ ] **Step 5: Commit**

```bash
git add src/server.ts vite.config.ts
git commit -m "feat: add GET /history endpoint to server"
```

---

## Task 6: Wire `PgVectorMemory` into `api-server.ts`

**Files:**
- Modify: `examples/api-server.ts`

The module-level code is refactored into an async IIFE so we can await a postgres connection check and fall back gracefully.

- [ ] **Step 1: Add imports at the top of `examples/api-server.ts`**

Add after the existing imports:

```typescript
import OpenAI from 'openai';
import { PgVectorMemory, createPgPool } from '../src/pg-memory';
import { ListMemory } from '../src/memory';
import type { BaseMemory } from '../src/memory';
```

- [ ] **Step 2: Replace the agent factory, server creation, and `app.listen` with an async IIFE**

Delete everything from `// Agent factory — fresh instance per request` through to the end of the file. Replace with:

```typescript
// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

const PORT = 3000;

(async () => {
  // Attempt postgres connection; fall back to in-memory if unavailable
  let agentMemory: BaseMemory;
  let getHistory: ((limit: number) => Promise<unknown[]>) | undefined;

  const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql://localhost/tsagent';
  const openaiClient = new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] });

  try {
    const pool      = createPgPool(DATABASE_URL);
    await pool.query('SELECT 1'); // connection test
    const pgMemory  = new PgVectorMemory(pool, openaiClient);
    agentMemory     = pgMemory;
    getHistory      = (limit) => pgMemory.getHistory(limit);
    console.log('[startup] postgres memory: connected');
  } catch (err) {
    console.warn('[startup] postgres unavailable, falling back to in-memory:', err);
    agentMemory = new ListMemory();
  }

  function createWeatherAgent(): OpenAIAgent {
    return new OpenAIAgent(
      'weather-agent',
      `You are a helpful weather assistant with access to live forecast data.
Always call the fetch_weather tool first before answering any weather question.
Present results conversationally — include conditions, temperature range, wind,
chance of rain, and any notable hourly highlights. Be friendly and concise.`,
      {
        tools:        [fetchWeatherTool],
        memory:       agentMemory,
        middleware:   [new LoggingMiddleware()],
        streamTokens: true,
      },
    );
  }

  const app = createAgentServer(
    (message, signal) => {
      const agent = createWeatherAgent();
      return agent.runStream(message, signal);
    },
    {
      staticDir:  path.join(__dirname, '../dist/ui'),
      getHistory,
    },
  );

  app.listen(PORT, () => {
    console.log(`\nWeather agent → http://localhost:${PORT}\n`);
    console.log(`  curl -sN -X POST http://localhost:${PORT}/chat \\`);
    console.log(`    -H 'Content-Type: application/json' \\`);
    console.log(`    -d '{"message": "What\\'s the weather in Tokyo tomorrow?"}'`);
    console.log('');
  });
})();
```

- [ ] **Step 3: Typecheck**

```bash
yarn typecheck
# Expected: no errors
```

- [ ] **Step 4: Commit**

```bash
git add examples/api-server.ts
git commit -m "feat: wire PgVectorMemory into api-server with postgres fallback"
```

---

## Task 7: UI — `isThinking` + history hydration in `useChat.ts`

**Files:**
- Modify: `src/ui/hooks/useChat.ts`

- [ ] **Step 1: Add `isThinking` to `UIMessage` interface**

Update the interface at the top of the file:

```typescript
export interface UIMessage {
  id:          string;
  role:        'user' | 'assistant';
  content:     string;
  contentType: 'text' | 'markdown';
  isStreaming: boolean;
  isThinking:  boolean;
  cancelled?:  boolean;
}
```

- [ ] **Step 2: Add history hydration `useEffect`**

Add this `useEffect` inside the `useChat` function, after the state declarations (after `const controllerRef = ...`):

```typescript
useEffect(() => {
  fetch('/history?limit=50')
    .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((data: Array<{
      id:          number;
      role:        string;
      content:     string;
      contentType: string;
      source:      string;
      createdAt:   string;
    }>) => {
      setMessages(
        data.map(m => ({
          id:          String(m.id),
          role:        m.role as 'user' | 'assistant',
          content:     m.content,
          contentType: (m.contentType as 'text' | 'markdown') ?? 'text',
          isStreaming: false,
          isThinking:  false,
        })),
      );
    })
    .catch(() => {
      // silently start with empty list if history unavailable
    });
}, []);
```

- [ ] **Step 3: Update `sendMessage` — set `isThinking: true` on the placeholder**

In `sendMessage`, update the assistant placeholder in `setMessages`:

```typescript
setMessages(prev => [
  ...prev,
  { id: crypto.randomUUID(), role: 'user',      content: text, contentType: 'text', isStreaming: false, isThinking: false },
  { id: assistantId,         role: 'assistant', content: '',   contentType: 'text', isStreaming: true,  isThinking: true  },
]);
```

- [ ] **Step 4: Flip `isThinking` to `false` on first `token` event**

In the `case 'token':` block inside the `for await` loop:

```typescript
case 'token':
  setMessages(prev => prev.map(m =>
    m.id === assistantId
      ? { ...m, content: m.content + (event.content ?? ''), isThinking: false }
      : m,
  ));
  break;
```

- [ ] **Step 5: Also clear `isThinking` in the `message` and error cases**

In `case 'message':`:

```typescript
case 'message':
  if (event.role === 'assistant') {
    setMessages(prev => prev.map(m =>
      m.id === assistantId
        ? { ...m, content: event.content ?? m.content, contentType: event.contentType ?? 'text', isStreaming: false, isThinking: false }
        : m,
    ));
  }
  break;
```

In `case 'error':`:

```typescript
case 'error':
  patchLastAssistant({ content: `Error: ${event.error ?? 'unknown'}`, isStreaming: false, isThinking: false });
  break;
```

In the `catch` block:

```typescript
} catch (err) {
  const isAbort = (err as Error).name === 'AbortError';
  patchLastAssistant({
    isStreaming: false,
    isThinking:  false,
    cancelled:   isAbort,
    ...(isAbort ? {} : { content: `Error: ${(err as Error).message}` }),
  });
}
```

- [ ] **Step 6: Typecheck**

```bash
yarn typecheck
# Expected: no errors
```

- [ ] **Step 7: Commit**

```bash
git add src/ui/hooks/useChat.ts
git commit -m "feat: add isThinking to UIMessage and history hydration on mount"
```

---

## Task 8: UI — "Thinking…" indicator in `Message.tsx`

**Files:**
- Modify: `src/ui/components/Message.tsx`

- [ ] **Step 1: Destructure `isThinking` from props**

Update the destructuring in `Message`:

```typescript
export function Message({ role, content, contentType, isStreaming, isThinking, cancelled }: MessageProps) {
```

- [ ] **Step 2: Replace the content render block**

Replace the existing ternary in the bubble div with:

```tsx
{isThinking ? (
  <span className="animate-pulse text-muted-foreground">Thinking…</span>
) : isUser || (!isStreaming && contentType === 'markdown') ? (
  isUser ? (
    <span className="whitespace-pre-wrap">{content}</span>
  ) : (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code: (props) => <CodeBlock {...props} />,
        p:    ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
        ul:   ({ children }) => <ul className="mb-2 list-disc pl-5 last:mb-0">{children}</ul>,
        ol:   ({ children }) => <ol className="mb-2 list-decimal pl-5 last:mb-0">{children}</ol>,
        li:   ({ children }) => <li className="mb-0.5">{children}</li>,
        h1:   ({ children }) => <h1 className="mb-2 text-lg font-bold">{children}</h1>,
        h2:   ({ children }) => <h2 className="mb-2 text-base font-semibold">{children}</h2>,
        h3:   ({ children }) => <h3 className="mb-1 font-semibold">{children}</h3>,
        blockquote: ({ children }) => (
          <blockquote className="mb-2 border-l-2 border-muted-foreground pl-3 italic text-muted-foreground">
            {children}
          </blockquote>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  )
) : (
  <span className="whitespace-pre-wrap">
    {content}
    {isStreaming && (
      <span className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[1px] animate-pulse bg-current opacity-70" />
    )}
  </span>
)}
```

- [ ] **Step 3: Typecheck**

```bash
yarn typecheck
# Expected: no errors
```

- [ ] **Step 4: Run all tests**

```bash
yarn test
# Expected: PASS — all tests
```

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/Message.tsx
git commit -m "feat: show Thinking… indicator while waiting for first token"
```

---

## Task 9: Integration smoke test

- [ ] **Step 1: Start the server**

Ensure `DATABASE_URL` and `OPENAI_API_KEY` are set, then:

```bash
yarn dev
```

Expected output includes both `[vite]` and `Weather agent → http://localhost:3000`.

- [ ] **Step 2: Verify history endpoint**

```bash
curl -s http://localhost:3000/history | jq .
# Expected: [] on a fresh database, or an array of message objects with id, role, content, contentType, createdAt
```

- [ ] **Step 3: Send a message and verify it persists**

Open `http://localhost:5173`, send "What's the weather in Paris today?". After the response completes:

```bash
curl -s http://localhost:3000/history | jq 'length'
# Expected: 2 (one user message, one assistant message)
```

- [ ] **Step 4: Verify the Thinking… indicator appears**

After sending a new message, the assistant bubble should show "Thinking…" (pulsing) for ~1–3 seconds before tokens begin streaming in. Confirm it disappears once the first token arrives.

- [ ] **Step 5: Reload the page and verify history loads**

Reload `http://localhost:5173`. The previous messages should already be visible before sending any new message.

- [ ] **Step 6: Verify semantic memory injection (optional — requires 2+ exchanges)**

Send two messages about different topics, then send a third that relates to the first. Check server logs — the system message passed to OpenAI should contain a "Recent conversation:" and "Relevant past context:" block.

```bash
# Server logs will show the full system message via LoggingMiddleware
```
