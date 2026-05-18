# Topic Assignment Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken string-based subtopic system with a dynamic LLM-driven hierarchical topic tree that automatically assigns topics to new flashcards and splits over-sized topics into child topics.

**Architecture:** A new `TopicAssignmentAgent` class (plain class, not an `OpenAIAgent` subclass) makes direct OpenAI JSON-mode calls to assign topics to newly created flashcards and to split root topics that exceed 6 cards. Assignment is fire-and-forget after `extract()`; splitting is fire-and-forget during live use and sequential during the backfill script.

**Tech Stack:** TypeScript, Vitest, PostgreSQL (`pg`), OpenAI API (`gpt-4o-mini`, JSON mode)

---

## File Map

| File | Action |
|---|---|
| `src/topic-assignment-agent.ts` | **Create** — new agent class |
| `src/topic-assignment-agent.test.ts` | **Create** — Vitest tests |
| `src/scripts/backfill-topics.ts` | **Create** — destructive reset + rebuild script |
| `src/topic-determination-agent.ts` | **Delete** |
| `src/topic-determination-agent.test.ts` | **Delete** |
| `src/types.ts` | **Modify** — update `TopicTree`, `FlashcardCard`, `FlashcardFilter` |
| `src/flashcard-agent.ts` | **Modify** — constructor, `extract()`, `getTopicsWithSubtopics()`, `getDueFlashcards` tool, `_fetchById()` |
| `src/pg-memory.ts` | **Modify** — remove `determineMessageTopic` import and call |
| `src/server.ts` | **Modify** — remove subtopics from flashcard filter |
| `src/start-server.ts` | **Modify** — pass `openaiClient` to `FlashcardAgent` |
| `src/ui/lib/types.ts` | **Modify** — update `TopicTree`, `FlashcardFilter` |
| `src/ui/hooks/useFlashcard.ts` | **Modify** — remove `subtopic` from `FlashcardData` |
| `src/ui/components/TopicFilterDropdown.tsx` | **Modify** — use `children` instead of `subtopics` |

---

## Task 1: Schema migration

**Files:**
- Create: `src/scripts/migrate-topic-schema.sql`

- [ ] **Step 1: Create migration file**

```sql
-- src/scripts/migrate-topic-schema.sql
ALTER TABLE topics ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES topics(id) NULL;
ALTER TABLE flashcards DROP COLUMN IF EXISTS subtopic;
```

- [ ] **Step 2: Run the migration**

```bash
cd /Users/nicholasfield/dev/multi-agen-system-exercises/ts-agent
npx ts-node -e "
require('dotenv').config({ path: '.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgresql://localhost/tsagent' });
pool.query('ALTER TABLE topics ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES topics(id) NULL')
  .then(() => pool.query('ALTER TABLE flashcards DROP COLUMN IF EXISTS subtopic'))
  .then(() => { console.log('Migration complete'); return pool.end(); })
  .then(() => process.exit(0))
  .catch(e => { console.error(e); process.exit(1); });
"
```

Expected output: `Migration complete`

- [ ] **Step 3: Commit**

```bash
git add src/scripts/migrate-topic-schema.sql
git commit -m "feat: add parent_id to topics, drop flashcards.subtopic"
```

---

## Task 2: Update shared types

**Files:**
- Modify: `src/types.ts`
- Modify: `src/ui/lib/types.ts`

- [ ] **Step 1: Update `TopicTree`, `FlashcardCard`, `FlashcardFilter` in `src/types.ts`**

Replace the three interfaces (lines 117–126):

```typescript
export interface TopicTree {
  id: number;
  label: string;
  parentId: number | null;
  children: { id: number; label: string }[];
}

export interface FlashcardFilter {
  topicIds?: number[];
}
```

Remove `subtopic: string | null` from `FlashcardCard` (leave all other fields):

```typescript
export interface FlashcardCard {
  id: number;
  question: string;
  answer: string;
  topicId: number | null;
  topicLabel: string | null;
}
```

- [ ] **Step 2: Update `src/ui/lib/types.ts`**

Replace the entire file:

```typescript
export interface TopicTree {
  id: number;
  label: string;
  parentId: number | null;
  children: { id: number; label: string }[];
}

export interface FlashcardFilter {
  topicIds?: number[];
}
```

- [ ] **Step 3: Run typecheck to see what breaks (expected)**

```bash
npx tsc --noEmit 2>&1 | head -60
```

Expected: many errors — that's fine, the remaining tasks fix them all.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/ui/lib/types.ts
git commit -m "refactor: replace subtopics string array with children topic tree type"
```

---

## Task 3: Delete topic-determination-agent and clean up pg-memory

**Files:**
- Delete: `src/topic-determination-agent.ts`
- Delete: `src/topic-determination-agent.test.ts`
- Modify: `src/pg-memory.ts`
- Modify: `src/flashcard-agent.ts` (import only — full rewrite in Task 5)

- [ ] **Step 1: Delete both files**

```bash
rm src/topic-determination-agent.ts src/topic-determination-agent.test.ts
```

- [ ] **Step 2: Remove `determineMessageTopic` from `pg-memory.ts`**

Remove line 4:
```typescript
import { determineMessageTopic } from './topic-determination-agent';
```

Remove the fire-and-forget block in `add()` (after the `RETURNING id` query, remove these lines):
```typescript
// Determine topic asynchronously (fire-and-forget, don't block message storage)
determineMessageTopic(content, this.pool)
  .then(assignment => {
    if (assignment) {
      return this.pool.query(
        'UPDATE messages SET topic_id = $1, subtopic = $2 WHERE id = $3',
        [assignment.topicId, assignment.subtopic, messageId],
      );
    }
  })
  .catch(err => {
    console.error('[PgVectorMemory] Topic determination failed:', err);
  });
```

- [ ] **Step 3: Remove `determineMessageTopic` import from `flashcard-agent.ts`**

Remove this line from the top of `src/flashcard-agent.ts`:
```typescript
import { determineMessageTopic } from "./topic-determination-agent";
```

- [ ] **Step 4: Run typecheck**

```bash
npx tsc --noEmit 2>&1 | grep "topic-determination" | head -10
```

Expected: no matches (all references to the deleted file are gone).

- [ ] **Step 5: Commit**

```bash
git add src/pg-memory.ts src/flashcard-agent.ts
git rm src/topic-determination-agent.ts src/topic-determination-agent.test.ts
git commit -m "refactor: delete TopicDeterminationAgent, remove from pg-memory pipeline"
```

---

## Task 4: Create TopicAssignmentAgent (TDD)

**Files:**
- Create: `src/topic-assignment-agent.test.ts`
- Create: `src/topic-assignment-agent.ts`

- [ ] **Step 1: Write failing tests**

Create `src/topic-assignment-agent.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { TopicAssignmentAgent } from './topic-assignment-agent';
import type pg from 'pg';
import type OpenAI from 'openai';

// Shared query handler — used by both pool.query and client.query so all SQL is tracked.
function makeMockPool(config: {
  cards?: Array<{ id: number; question: string; answer: string }>;
  topics?: Array<{ id: number; label: string; parent_id: number | null; card_count: string }>;
  splitGuard?: { count: string; parent_id: number | null };
  topicCards?: Array<{ id: number; question: string; answer: string }>;
  topicLabel?: string;
  countAfterAssign?: string;
} = {}) {
  let nextId = 100;
  const allSql: string[] = [];

  const handle = vi.fn(async (sql: string, _params?: unknown[]) => {
    allSql.push(sql);
    if (sql.includes('SELECT id, question, answer FROM flashcards WHERE id = ANY')) {
      return { rows: config.cards ?? [] };
    }
    if (sql.includes('SELECT t.id, t.label, t.parent_id, COUNT')) {
      return { rows: config.topics ?? [] };
    }
    if (sql.includes('INSERT INTO topics') && sql.includes('RETURNING id')) {
      return { rows: [{ id: nextId++ }] };
    }
    if (sql.includes('UPDATE flashcards SET topic_id')) {
      return { rows: [] };
    }
    if (sql.includes('COUNT(*) AS count, t.parent_id') || sql.includes('COUNT(f.id) AS count')) {
      return { rows: [config.splitGuard ?? { count: '3', parent_id: null }] };
    }
    if (sql.includes('SELECT id, question, answer FROM flashcards WHERE topic_id')) {
      return { rows: config.topicCards ?? [] };
    }
    if (sql.includes('SELECT label FROM topics WHERE id')) {
      return { rows: [{ label: config.topicLabel ?? 'Data Structures' }] };
    }
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [] };
    }
    return { rows: [] };
  });

  const pool = {
    query: handle,
    connect: vi.fn(async () => ({ query: handle, release: vi.fn() })),
    _allSql: allSql,
    _handle: handle,
  } as unknown as pg.Pool & { _allSql: string[]; _handle: typeof handle };

  return pool;
}

function makeMockOpenAI(response: object) {
  return {
    chat: {
      completions: {
        create: vi.fn(async () => ({
          choices: [{ message: { content: JSON.stringify(response) } }],
        })),
      },
    },
  } as unknown as OpenAI;
}

describe('TopicAssignmentAgent', () => {
  describe('assignTopics', () => {
    it('assigns a flashcard to an existing topic', async () => {
      const pool = makeMockPool({
        cards: [{ id: 1, question: 'What is O(n)?', answer: 'Linear time' }],
        topics: [{ id: 3, label: 'Algorithms', parent_id: null, card_count: '2' }],
      });
      const openai = makeMockOpenAI({ assignments: [{ flashcardId: 1, topicId: 3 }] });
      const agent = new TopicAssignmentAgent(pool, openai);

      await agent.assignTopics([1]);

      const updateCall = pool._handle.mock.calls.find(
        (c) => (c[0] as string).includes('UPDATE flashcards SET topic_id'),
      );
      expect(updateCall).toBeDefined();
      expect(updateCall![1]).toEqual([3, 1]);
    });

    it('creates a new topic when the LLM returns newTopicLabel', async () => {
      const pool = makeMockPool({
        cards: [{ id: 2, question: 'What is recursion?', answer: 'A function calling itself' }],
        topics: [],
      });
      const openai = makeMockOpenAI({ assignments: [{ flashcardId: 2, newTopicLabel: 'Recursion' }] });
      const agent = new TopicAssignmentAgent(pool, openai);

      await agent.assignTopics([2]);

      const insertCall = pool._handle.mock.calls.find(
        (c) => (c[0] as string).includes('INSERT INTO topics'),
      );
      expect(insertCall).toBeDefined();
      expect(insertCall![1]).toContain('Recursion');
    });

    it('deduplicates new topic labels within the same batch', async () => {
      const pool = makeMockPool({
        cards: [
          { id: 1, question: 'Q1', answer: 'A1' },
          { id: 2, question: 'Q2', answer: 'A2' },
        ],
        topics: [],
      });
      const openai = makeMockOpenAI({
        assignments: [
          { flashcardId: 1, newTopicLabel: 'Recursion' },
          { flashcardId: 2, newTopicLabel: 'Recursion' },
        ],
      });
      const agent = new TopicAssignmentAgent(pool, openai);

      await agent.assignTopics([1, 2]);

      const insertCalls = pool._handle.mock.calls.filter(
        (c) => (c[0] as string).includes('INSERT INTO topics'),
      );
      expect(insertCalls).toHaveLength(1);
    });

    it('does not trigger split when topic count is below threshold', async () => {
      const pool = makeMockPool({
        cards: [{ id: 1, question: 'Q', answer: 'A' }],
        topics: [{ id: 3, label: 'Algorithms', parent_id: null, card_count: '1' }],
        splitGuard: { count: '2', parent_id: null }, // below 6
      });
      const openai = makeMockOpenAI({ assignments: [{ flashcardId: 1, topicId: 3 }] });
      const agent = new TopicAssignmentAgent(pool, openai);
      const splitSpy = vi.spyOn(agent, 'splitTopic');

      await agent.assignTopics([1]);

      expect(splitSpy).not.toHaveBeenCalled();
    });
  });

  describe('splitTopic', () => {
    it('creates two child topics and reassigns cards', async () => {
      const pool = makeMockPool({
        splitGuard: { count: '6', parent_id: null },
        topicCards: [
          { id: 1, question: 'Q1', answer: 'A1' },
          { id: 2, question: 'Q2', answer: 'A2' },
          { id: 3, question: 'Q3', answer: 'A3' },
          { id: 4, question: 'Q4', answer: 'A4' },
          { id: 5, question: 'Q5', answer: 'A5' },
          { id: 6, question: 'Q6', answer: 'A6' },
        ],
      });
      const openai = makeMockOpenAI({
        group1: { label: 'Sorting', flashcardIds: [1, 2, 3] },
        group2: { label: 'Searching', flashcardIds: [4, 5, 6] },
      });
      const agent = new TopicAssignmentAgent(pool, openai);

      await agent.splitTopic(5);

      const insertCalls = pool._handle.mock.calls.filter(
        (c) => (c[0] as string).includes('INSERT INTO topics'),
      );
      expect(insertCalls).toHaveLength(2);
      expect(insertCalls[0]![1]).toContain('Sorting');
      expect(insertCalls[1]![1]).toContain('Searching');
    });

    it('aborts if LLM puts all cards in one group', async () => {
      const pool = makeMockPool({
        splitGuard: { count: '6', parent_id: null },
        topicCards: [{ id: 1, question: 'Q', answer: 'A' }],
      });
      const openai = makeMockOpenAI({
        group1: { label: 'All', flashcardIds: [1, 2, 3, 4, 5, 6] },
        group2: { label: 'Empty', flashcardIds: [] },
      });
      const agent = new TopicAssignmentAgent(pool, openai);

      await agent.splitTopic(5);

      const insertCalls = pool._handle.mock.calls.filter(
        (c) => (c[0] as string).includes('INSERT INTO topics'),
      );
      expect(insertCalls).toHaveLength(0);
    });

    it('aborts if topic already has a parent (idempotency guard)', async () => {
      const pool = makeMockPool({
        splitGuard: { count: '6', parent_id: 1 }, // has parent
      });
      const openai = makeMockOpenAI({});
      const agent = new TopicAssignmentAgent(pool, openai);

      await agent.splitTopic(5);

      expect((openai.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/topic-assignment-agent.test.ts 2>&1 | tail -20
```

Expected: `Cannot find module './topic-assignment-agent'`

- [ ] **Step 3: Implement `src/topic-assignment-agent.ts`**

```typescript
import pg from "pg";
import OpenAI from "openai";

interface AssignmentEntry {
  flashcardId: number;
  topicId?: number;
  newTopicLabel?: string;
}

interface SplitGroup {
  label: string;
  flashcardIds: number[];
}

export class TopicAssignmentAgent {
  constructor(
    private pool: pg.Pool,
    private openai: OpenAI,
  ) {}

  async assignTopics(
    flashcardIds: number[],
    opts: { skipAutoSplit?: boolean } = {},
  ): Promise<void> {
    if (flashcardIds.length === 0) return;

    const { rows: cards } = await this.pool.query<{
      id: number;
      question: string;
      answer: string;
    }>(
      "SELECT id, question, answer FROM flashcards WHERE id = ANY($1)",
      [flashcardIds],
    );

    const { rows: topics } = await this.pool.query<{
      id: number;
      label: string;
      parent_id: number | null;
      card_count: string;
    }>(
      `SELECT t.id, t.label, t.parent_id, COUNT(f.id) AS card_count
       FROM topics t
       LEFT JOIN flashcards f ON f.topic_id = t.id
       GROUP BY t.id, t.label, t.parent_id
       ORDER BY t.label`,
    );

    const prompt = `You are a topic classifier for a flashcard learning system.

${
  topics.length > 0
    ? `Existing topics:\n${topics.map((t) => `- ID ${t.id}: ${t.label} (${t.card_count} cards)`).join("\n")}`
    : "There are no existing topics yet."
}

Flashcards to classify:
${cards.map((c) => `- ID ${c.id}: Q: ${c.question} / A: ${c.answer}`).join("\n")}

For each flashcard, assign it to the most relevant existing topic (provide topicId), or propose a concise new topic label if none fit (provide newTopicLabel). Respond with valid JSON only:
{"assignments":[{"flashcardId":1,"topicId":3},{"flashcardId":2,"newTopicLabel":"Recursion"}]}`;

    const raw = await this._callLlm(prompt);
    if (!raw) return;

    let assignments: AssignmentEntry[];
    try {
      assignments = (JSON.parse(raw) as { assignments: AssignmentEntry[] }).assignments;
    } catch {
      const retry = await this._callLlm(
        prompt + "\n\nIMPORTANT: Respond with valid JSON only, no other text.",
      );
      if (!retry) return;
      try {
        assignments = (JSON.parse(retry) as { assignments: AssignmentEntry[] }).assignments;
      } catch {
        console.error("[TopicAssignmentAgent] Failed to parse LLM response after retry");
        return;
      }
    }

    // Create new topics, deduplicating labels within this batch
    const newLabelToId = new Map<string, number>();
    for (const a of assignments) {
      if (a.newTopicLabel && !newLabelToId.has(a.newTopicLabel)) {
        const { rows } = await this.pool.query<{ id: number }>(
          "INSERT INTO topics (label) VALUES ($1) RETURNING id",
          [a.newTopicLabel],
        );
        newLabelToId.set(a.newTopicLabel, rows[0]!.id);
      }
    }

    // Assign each card
    const affectedTopicIds = new Set<number>();
    for (const a of assignments) {
      const topicId = a.topicId ?? newLabelToId.get(a.newTopicLabel ?? "");
      if (!topicId) continue;
      await this.pool.query("UPDATE flashcards SET topic_id = $1 WHERE id = $2", [
        topicId,
        a.flashcardId,
      ]);
      affectedTopicIds.add(topicId);
    }

    if (opts.skipAutoSplit) return;

    // Fire-and-forget split for topics that just crossed the threshold
    for (const topicId of affectedTopicIds) {
      const { rows } = await this.pool.query<{
        count: string;
        parent_id: number | null;
      }>(
        `SELECT COUNT(f.id) AS count, t.parent_id
         FROM topics t
         LEFT JOIN flashcards f ON f.topic_id = t.id
         WHERE t.id = $1
         GROUP BY t.parent_id`,
        [topicId],
      );
      if (rows[0] && parseInt(rows[0].count) >= 6 && rows[0].parent_id === null) {
        this.splitTopic(topicId).catch((err) =>
          console.error(`[TopicAssignmentAgent] splitTopic(${topicId}) failed:`, err),
        );
      }
    }
  }

  async splitTopic(topicId: number): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Idempotency: re-verify conditions inside the transaction
      const { rows: guard } = await client.query<{
        count: string;
        parent_id: number | null;
      }>(
        `SELECT COUNT(f.id) AS count, t.parent_id
         FROM topics t
         LEFT JOIN flashcards f ON f.topic_id = t.id
         WHERE t.id = $1
         GROUP BY t.parent_id`,
        [topicId],
      );

      if (!guard[0] || parseInt(guard[0].count) < 6 || guard[0].parent_id !== null) {
        await client.query("ROLLBACK");
        return;
      }

      const { rows: cards } = await client.query<{
        id: number;
        question: string;
        answer: string;
      }>("SELECT id, question, answer FROM flashcards WHERE topic_id = $1", [topicId]);

      const { rows: topicRows } = await client.query<{ label: string }>(
        "SELECT label FROM topics WHERE id = $1",
        [topicId],
      );
      const topicLabel = topicRows[0]?.label ?? "Unknown";

      const prompt = `You are reorganizing flashcards that have grown too numerous under one topic.

Current topic: "${topicLabel}" (being split into 2 groups)

Flashcards:
${cards.map((c) => `- ID ${c.id}: Q: ${c.question} / A: ${c.answer}`).join("\n")}

Split these into exactly 2 cohesive subtopic groups and give each a specific label. Every flashcard ID must appear in exactly one group. Respond with valid JSON only:
{"group1":{"label":"Specific Label A","flashcardIds":[1,3,5]},"group2":{"label":"Specific Label B","flashcardIds":[2,4,6]}}`;

      const raw = await this._callLlm(prompt);
      if (!raw) {
        await client.query("ROLLBACK");
        return;
      }

      let split: { group1: SplitGroup; group2: SplitGroup };
      try {
        split = JSON.parse(raw) as { group1: SplitGroup; group2: SplitGroup };
      } catch {
        console.error(`[TopicAssignmentAgent] splitTopic(${topicId}): malformed LLM response`);
        await client.query("ROLLBACK");
        return;
      }

      if (!split.group1?.flashcardIds?.length || !split.group2?.flashcardIds?.length) {
        console.warn(
          `[TopicAssignmentAgent] splitTopic(${topicId}): LLM did not produce 2 non-empty groups, aborting`,
        );
        await client.query("ROLLBACK");
        return;
      }

      const { rows: child1 } = await client.query<{ id: number }>(
        "INSERT INTO topics (label, parent_id) VALUES ($1, $2) RETURNING id",
        [split.group1.label, topicId],
      );
      const { rows: child2 } = await client.query<{ id: number }>(
        "INSERT INTO topics (label, parent_id) VALUES ($1, $2) RETURNING id",
        [split.group2.label, topicId],
      );

      await client.query("UPDATE flashcards SET topic_id = $1 WHERE id = ANY($2)", [
        child1[0]!.id,
        split.group1.flashcardIds,
      ]);
      await client.query("UPDATE flashcards SET topic_id = $1 WHERE id = ANY($2)", [
        child2[0]!.id,
        split.group2.flashcardIds,
      ]);

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  private async _callLlm(prompt: string): Promise<string | null> {
    try {
      const res = await this.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      });
      return res.choices[0]?.message.content ?? null;
    } catch (err) {
      console.error("[TopicAssignmentAgent] LLM call failed:", err);
      return null;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/topic-assignment-agent.test.ts
```

Expected: `6 passed`

- [ ] **Step 5: Commit**

```bash
git add src/topic-assignment-agent.ts src/topic-assignment-agent.test.ts
git commit -m "feat: add TopicAssignmentAgent with assignTopics and splitTopic"
```

---

## Task 5: Update FlashcardAgent

**Files:**
- Modify: `src/flashcard-agent.ts`

- [ ] **Step 1: Add import and `_topicAgent` field**

Add to imports at top of `src/flashcard-agent.ts`:
```typescript
import OpenAI from "openai";
import { TopicAssignmentAgent } from "./topic-assignment-agent";
```

Add `private _topicAgent: TopicAssignmentAgent;` to the class fields (alongside `_pool`, `_state`, etc.).

- [ ] **Step 2: Update constructor signature and body**

Replace:
```typescript
constructor(pool: pg.Pool) {
```
With:
```typescript
constructor(pool: pg.Pool, openai: OpenAI) {
```

Add at the end of the constructor body (after `this._filterRef = filterRef;`):
```typescript
this._topicAgent = new TopicAssignmentAgent(pool, openai);
```

- [ ] **Step 3: Rewrite `extract()`**

Replace the entire `extract()` method:

```typescript
async extract(userMsg: string, assistantMsg: string): Promise<void> {
  if (!assistantMsg.trim()) return;

  this._extractState.savedCards = [];
  this.context.messages = [];
  this.instructions = EXTRACTION_INSTRUCTIONS;

  await this.run(
    `Extract flashcards from this exchange:\n\nUser: "${userMsg}"\nAssistant: "${assistantMsg}"`,
  );

  const newIds: number[] = [];
  for (const card of this._extractState.savedCards) {
    const isDup = await this._isDuplicate(card.question);
    if (!isDup) {
      const { rows } = await this._pool.query<{ id: number }>(
        `INSERT INTO flashcards (question, answer) VALUES ($1, $2) RETURNING id`,
        [card.question, card.answer],
      );
      if (rows[0]) newIds.push(rows[0].id);
    }
  }

  if (newIds.length > 0) {
    this._topicAgent.assignTopics(newIds).catch(console.error);
  }
}
```

- [ ] **Step 4: Update `getDueFlashcards` tool — remove subtopic filter**

In `buildSelectionTools`, replace the filter-building logic inside `getDueFlashcards`:

```typescript
const args: unknown[] = [limit];
const parts: string[] = [];

if (filter?.topicIds && filter.topicIds.length > 0) {
  parts.push(`f.topic_id = ANY($${args.push(filter.topicIds)}::int[])`);
}

const filterClause = parts.length > 0 ? `AND (${parts.join(" OR ")})` : "";
```

Remove the `subtopics` loop entirely. Remove `subtopic` from the SELECT query:

```typescript
const { rows } = await pool.query<{
  id: number;
  question: string;
  topic_id: number | null;
  topic_label: string | null;
  last_score: string | null;
  next_due_at: string;
}>(
  `SELECT f.id, f.question, f.topic_id, t.label AS topic_label, f.next_due_at,
          r.score AS last_score
   FROM flashcards f
   LEFT JOIN topics t ON f.topic_id = t.id
   LEFT JOIN LATERAL (
     SELECT score FROM flashcard_reviews
     WHERE flashcard_id = f.id
     ORDER BY reviewed_at DESC LIMIT 1
   ) r ON true
   WHERE (f.next_due_at <= now() OR f.repetitions = 0)
   ${filterClause}
   ORDER BY f.next_due_at ASC, f.repetitions ASC
   LIMIT $1`,
  args,
);
```

Update the `hasFilter` check in `selectForReview`:
```typescript
const hasFilter = (filter?.topicIds?.length ?? 0) > 0;
```

- [ ] **Step 5: Rewrite `getTopicsWithSubtopics()`**

Replace the entire method:

```typescript
async getTopicsWithSubtopics(): Promise<TopicTree[]> {
  const { rows } = await this._pool.query<{
    id: number;
    label: string;
    parent_id: number | null;
  }>("SELECT id, label, parent_id FROM topics ORDER BY label");

  const childrenByParent = new Map<number, { id: number; label: string }[]>();
  for (const row of rows) {
    if (row.parent_id !== null) {
      const arr = childrenByParent.get(row.parent_id) ?? [];
      arr.push({ id: row.id, label: row.label });
      childrenByParent.set(row.parent_id, arr);
    }
  }

  return rows
    .filter((r) => r.parent_id === null)
    .map((r) => ({
      id: r.id,
      label: r.label,
      parentId: null,
      children: childrenByParent.get(r.id) ?? [],
    }));
}
```

- [ ] **Step 6: Update `_fetchById()` — remove subtopic**

Replace:
```typescript
private async _fetchById(id: number): Promise<FlashcardCard | null> {
  const { rows } = await this._pool.query<{
    id: number;
    question: string;
    answer: string;
    topic_id: number | null;
    topic_label: string | null;
    subtopic: string | null;
  }>(
    `SELECT f.id, f.question, f.answer, f.topic_id, t.label AS topic_label, f.subtopic
     FROM flashcards f
     LEFT JOIN topics t ON f.topic_id = t.id
     WHERE f.id = $1`,
    [id],
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    id: r.id,
    question: r.question,
    answer: r.answer,
    topicId: r.topic_id,
    topicLabel: r.topic_label,
    subtopic: r.subtopic ?? null,
  };
}
```

With:
```typescript
private async _fetchById(id: number): Promise<FlashcardCard | null> {
  const { rows } = await this._pool.query<{
    id: number;
    question: string;
    answer: string;
    topic_id: number | null;
    topic_label: string | null;
  }>(
    `SELECT f.id, f.question, f.answer, f.topic_id, t.label AS topic_label
     FROM flashcards f
     LEFT JOIN topics t ON f.topic_id = t.id
     WHERE f.id = $1`,
    [id],
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    id: r.id,
    question: r.question,
    answer: r.answer,
    topicId: r.topic_id,
    topicLabel: r.topic_label,
  };
}
```

- [ ] **Step 7: Run typecheck**

```bash
npx tsc --noEmit 2>&1 | grep "flashcard-agent" | head -20
```

Expected: no errors from this file.

- [ ] **Step 8: Commit**

```bash
git add src/flashcard-agent.ts
git commit -m "feat: wire TopicAssignmentAgent into FlashcardAgent extract pipeline"
```

---

## Task 6: Update server.ts — remove subtopics from filter

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Simplify the POST `/flashcard` body parsing**

Replace the filter-building block:
```typescript
const body = req.body as { topicIds?: unknown; subtopics?: unknown };
const filter: FlashcardFilter = {
  topicIds: Array.isArray(body.topicIds)
    ? (body.topicIds as number[]).filter((x) => typeof x === "number")
    : undefined,
  subtopics: Array.isArray(body.subtopics)
    ? (body.subtopics as Array<{ topicId: number; subtopic: string }>).filter(
        (x) => typeof x.topicId === "number" && typeof x.subtopic === "string",
      )
    : undefined,
};
```

With:
```typescript
const body = req.body as { topicIds?: unknown };
const filter: FlashcardFilter = {
  topicIds: Array.isArray(body.topicIds)
    ? (body.topicIds as number[]).filter((x) => typeof x === "number")
    : undefined,
};
```

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit 2>&1 | grep "server.ts" | head -10
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/server.ts
git commit -m "refactor: remove subtopics from flashcard filter in server"
```

---

## Task 7: Update start-server.ts

**Files:**
- Modify: `src/start-server.ts`

- [ ] **Step 1: Pass `openaiClient` to `FlashcardAgent`**

Replace:
```typescript
flashcardAgent = new FlashcardAgent(pool);
```
With:
```typescript
flashcardAgent = new FlashcardAgent(pool, openaiClient);
```

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit 2>&1 | grep "start-server" | head -10
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/start-server.ts
git commit -m "fix: pass openaiClient to FlashcardAgent constructor"
```

---

## Task 8: Update UI

**Files:**
- Modify: `src/ui/hooks/useFlashcard.ts`
- Modify: `src/ui/components/TopicFilterDropdown.tsx`

- [ ] **Step 1: Remove `subtopic` from `FlashcardData` in `useFlashcard.ts`**

Replace:
```typescript
export interface FlashcardData {
  id: number;
  question: string;
  answer: string;
  topicLabel: string | null;
  subtopic: string | null;
}
```
With:
```typescript
export interface FlashcardData {
  id: number;
  question: string;
  answer: string;
  topicLabel: string | null;
}
```

- [ ] **Step 2: Rewrite `TopicFilterDropdown.tsx` to use `children` instead of `subtopics`**

Replace the entire file:

```typescript
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { TopicTree, FlashcardFilter } from "@/lib/types";

interface Props {
  topics: TopicTree[];
  filter: FlashcardFilter;
  onChange: (filter: FlashcardFilter) => void;
}

export function TopicFilterDropdown({ topics, filter, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const selectedCount = filter.topicIds?.length ?? 0;

  const isSelected = (id: number) => filter.topicIds?.includes(id) ?? false;

  const toggle = (id: number) => {
    const topicIds = filter.topicIds ?? [];
    const next = topicIds.includes(id)
      ? topicIds.filter((x) => x !== id)
      : [...topicIds, id];
    onChange({ topicIds: next.length > 0 ? next : undefined });
  };

  const clearAll = () => onChange({});

  const toggleExpand = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Filter by topic"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "6px 10px",
          borderRadius: 6,
          border: "1px solid var(--border)",
          background: selectedCount > 0 ? "var(--primary)" : "var(--background)",
          color: selectedCount > 0 ? "var(--primary-foreground)" : "var(--muted-foreground)",
          fontSize: 12,
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        Topics
        {selectedCount > 0 && (
          <span
            style={{
              background: "var(--primary-foreground)",
              color: "var(--primary)",
              borderRadius: 99,
              padding: "0 5px",
              fontSize: 10,
              fontWeight: 700,
            }}
          >
            {selectedCount}
          </span>
        )}
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            left: 0,
            width: 240,
            maxHeight: 320,
            overflowY: "auto",
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "8px 0",
            zIndex: 50,
            boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
          }}
        >
          {selectedCount > 0 && (
            <div style={{ padding: "0 12px 6px", borderBottom: "1px solid var(--border)", marginBottom: 4 }}>
              <button
                type="button"
                onClick={clearAll}
                style={{ fontSize: 11, color: "var(--muted-foreground)", cursor: "pointer", background: "none", border: "none" }}
              >
                Clear all
              </button>
            </div>
          )}
          {topics.length === 0 && (
            <p style={{ padding: "8px 12px", fontSize: 12, color: "var(--muted-foreground)" }}>
              No topics yet
            </p>
          )}
          {topics.map((topic) => (
            <div key={topic.id}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 12px", cursor: "pointer" }}>
                {topic.children.length > 0 && (
                  <button
                    type="button"
                    onClick={() => toggleExpand(topic.id)}
                    style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--muted-foreground)", display: "flex" }}
                  >
                    {expanded.has(topic.id) ? (
                      <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                  </button>
                )}
                {topic.children.length === 0 && <span style={{ width: 12 }} />}
                <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 13, color: "var(--foreground)", userSelect: "none", flex: 1 }}>
                  <input
                    type="checkbox"
                    checked={isSelected(topic.id)}
                    onChange={() => toggle(topic.id)}
                    style={{ cursor: "pointer" }}
                  />
                  {topic.label}
                </label>
              </div>
              {expanded.has(topic.id) &&
                topic.children.map((child) => (
                  <label
                    key={child.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "3px 12px 3px 32px",
                      cursor: "pointer",
                      fontSize: 12,
                      color: "var(--muted-foreground)",
                      userSelect: "none",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected(child.id)}
                      onChange={() => toggle(child.id)}
                      style={{ cursor: "pointer" }}
                    />
                    {child.label}
                  </label>
                ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Run typecheck across the entire project**

```bash
npx tsc --noEmit 2>&1
```

Expected: no errors. If any remain, they will be in components that reference `subtopic` — fix each by removing the reference.

- [ ] **Step 4: Commit**

```bash
git add src/ui/hooks/useFlashcard.ts src/ui/components/TopicFilterDropdown.tsx
git commit -m "refactor: update UI to use topic children tree instead of subtopics string array"
```

---

## Task 9: Create backfill script

**Files:**
- Create: `src/scripts/backfill-topics.ts`

- [ ] **Step 1: Create the script**

```typescript
import path from "path";
import { config } from "dotenv";
import OpenAI from "openai";
import { createPgPool } from "../pg-memory";
import { TopicAssignmentAgent } from "../topic-assignment-agent";

config({ path: path.join(__dirname, "../../.env") });

const BATCH_SIZE = 20;

async function main() {
  const DATABASE_URL =
    process.env["DATABASE_URL"] ?? "postgresql://localhost/tsagent";
  const openaiClient = new OpenAI({ apiKey: process.env["OPENAI_API_KEY"] });
  const pool = createPgPool(DATABASE_URL);
  const agent = new TopicAssignmentAgent(pool, openaiClient);

  console.log("[backfill] Starting destructive topic reset...");

  // 1. Wipe all topics and assignments in a transaction
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE flashcards SET topic_id = NULL");
    await client.query("DELETE FROM topics");
    await client.query("COMMIT");
    console.log("[backfill] All topics and assignments cleared.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[backfill] Reset transaction failed, aborting:", err);
    process.exit(1);
  } finally {
    client.release();
  }

  // 2. Fetch all flashcard IDs
  const { rows: idRows } = await pool.query<{ id: number }>(
    "SELECT id FROM flashcards ORDER BY id ASC",
  );
  const allIds = idRows.map((r) => r.id);
  const total = allIds.length;

  if (total === 0) {
    console.log("[backfill] No flashcards found. Done.");
    await pool.end();
    return;
  }

  console.log(
    `[backfill] Processing ${total} flashcards in batches of ${BATCH_SIZE}...`,
  );

  // 3. Process in batches
  const batches: number[][] = [];
  for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
    batches.push(allIds.slice(i, i + BATCH_SIZE));
  }

  let totalAssigned = 0;
  let totalTopicsCreated = 0;
  const failedBatches: number[] = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    try {
      const { rows: before } = await pool.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM topics",
      );
      const topicsBefore = parseInt(before[0]!.count);

      await agent.assignTopics(batch, { skipAutoSplit: true });
      totalAssigned += batch.length;

      const { rows: after } = await pool.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM topics",
      );
      const newTopics = parseInt(after[0]!.count) - topicsBefore;
      totalTopicsCreated += newTopics;

      console.log(
        `[backfill] batch ${i + 1}/${batches.length} — assigned ${batch.length} cards, created ${newTopics} new topics`,
      );
    } catch (err) {
      console.error(`[backfill] batch ${i + 1} failed:`, err);
      failedBatches.push(i + 1);
    }
  }

  // 4. Run splits sequentially for topics that exceeded the threshold
  console.log("[backfill] Checking for topics that need splitting...");
  const { rows: splitCandidates } = await pool.query<{
    id: number;
    label: string;
    count: string;
  }>(
    `SELECT t.id, t.label, COUNT(f.id) AS count
     FROM topics t
     LEFT JOIN flashcards f ON f.topic_id = t.id
     WHERE t.parent_id IS NULL
     GROUP BY t.id, t.label
     HAVING COUNT(f.id) >= 6`,
  );

  let totalSplit = 0;
  for (const topic of splitCandidates) {
    console.log(
      `[backfill] Splitting "${topic.label}" (${topic.count} cards)...`,
    );
    try {
      await agent.splitTopic(topic.id);
      totalSplit++;
    } catch (err) {
      console.error(`[backfill] Split failed for topic "${topic.label}":`, err);
    }
  }

  // 5. Summary
  console.log("\n[backfill] Complete!");
  console.log(`  Flashcards processed: ${totalAssigned}/${total}`);
  console.log(`  Topics created:       ${totalTopicsCreated}`);
  console.log(`  Topics split:         ${totalSplit}`);
  if (failedBatches.length > 0) {
    console.log(`  Failed batches:       ${failedBatches.join(", ")}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error("[backfill] Fatal error:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Commit**

```bash
git add src/scripts/backfill-topics.ts
git commit -m "feat: add destructive backfill-topics script for full topic rebuild"
```

---

## Task 10: Final typecheck, test run, and smoke test

- [ ] **Step 1: Run full typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 2: Run all tests**

```bash
npx vitest run
```

Expected: all tests pass, including `topic-assignment-agent.test.ts`.

- [ ] **Step 3: Restart the server and verify topics endpoint**

```bash
npx ts-node src/start-server.ts &
sleep 3
curl http://localhost:3000/topics
```

Expected: JSON array (empty if no topics yet, or populated if flashcards exist with topic_id).

- [ ] **Step 4: Send a chat message and confirm topic assignment fires**

In the running server's log, after sending any message via the UI, confirm you see no errors like `[TopicAssignmentAgent]`. New flashcards should now appear with topic_id set after a short delay.

- [ ] **Step 5: (Optional) Run the backfill to rebuild topics from all existing flashcards**

```bash
npx ts-node src/scripts/backfill-topics.ts
```

Expected output pattern:
```
[backfill] Starting destructive topic reset...
[backfill] All topics and assignments cleared.
[backfill] Processing N flashcards in batches of 20...
[backfill] batch 1/M — assigned 20 cards, created X new topics
...
[backfill] Complete!
  Flashcards processed: N/N
  Topics created:       X
  Topics split:         Y
```

- [ ] **Step 6: Check topics in UI**

Open the app, click the Topics button — should now show the rebuilt topic tree with root topics and any child topics from splits.

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "feat: complete topic assignment agent implementation"
```
