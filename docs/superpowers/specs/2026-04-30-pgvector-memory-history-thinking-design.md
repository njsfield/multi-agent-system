# Design: pgvector Memory, Conversation History, and Thinking Indicator

**Date:** 2026-04-30  
**Status:** Approved

---

## Overview

Three related features that add persistence and improved UX to the ts-agent:

1. **pgvector memory** — persist all conversation turns to postgres and use semantic search (via pgvector) to inject relevant past context into the LLM
2. **Conversation history** — surface the most recent 50 messages in the UI on load via a `GET /history` endpoint
3. **Thinking indicator** — show "Thinking…" in the assistant bubble while waiting for the first token

---

## Conversation Model

Single global conversation thread. All messages accumulate in one postgres table shared across requests. No sessions, no auth.

---

## Section 1: Data Layer

### Postgres Schema

```sql
-- Ordered conversation record (also serves the /history endpoint)
CREATE TABLE messages (
  id         BIGSERIAL PRIMARY KEY,
  role       TEXT NOT NULL,         -- 'user' | 'assistant'
  content    TEXT NOT NULL,
  source     TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Semantic memory index
CREATE TABLE message_embeddings (
  id         BIGSERIAL PRIMARY KEY,
  message_id BIGINT REFERENCES messages(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  embedding  VECTOR(1536),          -- text-embedding-3-small dimensions
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON message_embeddings USING ivfflat (embedding vector_cosine_ops);
```

The `messages` table is the single source of truth for both ordered history and the raw content used to generate embeddings. The `message_embeddings` table holds the vector index for semantic search.

### `PgVectorMemory` class

**New file: `src/pg-memory.ts`**

Implements `BaseMemory` from `src/memory.ts`. Dependencies: `pg` (postgres client), `openai` (for embeddings — already a project dependency).

Constructor arguments:
- `pool: pg.Pool` — shared connection pool
- `openai: OpenAI` — for generating embeddings via `text-embedding-3-small`

Methods:

| Method | Behaviour |
|--------|-----------|
| `add(content, metadata)` | Insert into `messages` (using `metadata.role` and `metadata.source`), generate embedding via `text-embedding-3-small`, insert into `message_embeddings` |
| `query(query, limit = 5)` | Embed the query string, run `ORDER BY embedding <=> $1 LIMIT $2` cosine similarity search on `message_embeddings`, return matching content strings |
| `getContext(maxItems = 20)` | `SELECT content FROM messages ORDER BY id DESC LIMIT $1` — returns recent messages without embedding overhead |

Also exports a `createPgPool(connectionString: string): pg.Pool` helper.

---

## Section 2: Agent Wiring

### Where `PgVectorMemory` is called in `Agent`

The existing `BaseAgent` declares `protected memory?: BaseMemory` but never calls it. This design wires it up in `runStream()` and `run()`.

**At the start of each turn:**

```
1. memory.getContext(20)
   → inject returned strings as historical messages into AgentContext
     (prepended before the current task messages in llmMessages)

2. memory.query(userMessageContent, 5)
   → inject top-K results as a "Relevant past context:" block
     appended to the system message content
```

**After the final assistant message is produced:**

```
3. memory.add(userMessageContent, { role: 'user', source: 'user' })
4. memory.add(assistantMessageContent, { role: 'assistant', source: agentName })
```

This means every completed exchange (user turn + assistant response) is persisted. Tool messages are not stored — only the final user input and final assistant output.

### Server changes (`src/server.ts`)

Add an optional `getHistory` callback to `AgentServerOptions`:

```typescript
export interface AgentServerOptions {
  staticDir?: string;
  getHistory?: (limit: number) => Promise<HistoryMessage[]>;
}

export interface HistoryMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  source: string;
  createdAt: string;  // ISO timestamp
}
```

Add `GET /history` endpoint that calls `getHistory(limit)` where `limit` comes from the `?limit=` query param (default 50, max 100). Returns a JSON array. If `getHistory` is not provided the endpoint returns 404.

The server itself has no direct postgres dependency — the caller wires in the query function.

### `examples/api-server.ts` changes

- Create a `pg.Pool` at module startup using `DATABASE_URL` env var
- Create one shared `PgVectorMemory` instance (pool + OpenAI client)
- Pass `getHistory: (limit) => pgMemory.getHistory(limit)` to `createAgentServer`
- Pass the shared `pgMemory` instance into each `createWeatherAgent()` call so it's shared across requests

`PgVectorMemory` also needs a `getHistory(limit: number): Promise<HistoryMessage[]>` method (a direct ordered query on the `messages` table — not part of `BaseMemory`, just a concrete method on `PgVectorMemory`).

---

## Section 3: UI Changes

### `useChat.ts`

**History hydration:**

A `useEffect` (runs once on mount) fetches `GET /history?limit=50`. The response maps to `UIMessage[]` (setting `isStreaming: false`, deriving `contentType` the same way the server does) and sets the initial `messages` state. The effect runs before the user sends anything.

**`isThinking` state:**

A `boolean` state variable in the hook:
- Set to `true` inside `sendMessage`, immediately after appending the assistant placeholder message
- Set to `false` when the first `token` or `message` SSE event is received

Exposed on the hook return:
```typescript
return { messages, isStreaming, isThinking, sendMessage, cancel };
```

### `Message.tsx`

Pass `isThinking` as a prop on the assistant message (set from the hook, not derived inside the component).

When `isThinking` is true and content is empty, render a "Thinking…" label instead of the blinking cursor:

```tsx
{isThinking && !content ? (
  <span className="animate-pulse text-muted-foreground">Thinking…</span>
) : (
  // existing streaming content + cursor render
)}
```

### `App.tsx`

Pass `isThinking` from `useChat` to the last assistant `Message` in the list (the one currently streaming).

### `sseClient.ts`

No changes required.

---

## Error Handling

- If postgres is unavailable at startup, log a warning and fall back to `ListMemory` (no history endpoint, no vector search)
- If embedding generation fails for a message, log the error and skip the `message_embeddings` insert — the message is still persisted in `messages`
- If `GET /history` fails, the UI silently starts with an empty list (same as today)

---

## Dependencies to Add

| Package | Purpose |
|---------|---------|
| `pg` | Postgres client |
| `@types/pg` | TypeScript types for pg |

The `openai` package is already a project dependency.

---

## Schema Migration

Run the DDL above manually against the local postgres instance before starting the server. No migration tooling is introduced — this is a dev-only setup.

```bash
psql $DATABASE_URL -f schema.sql
```

A `schema.sql` file will be added to the project root.
