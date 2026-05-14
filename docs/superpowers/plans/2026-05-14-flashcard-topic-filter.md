# Flashcard Topic Filter & Multi-Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add on-demand flashcard fetching with a nested topic/subtopic filter dropdown in the chat bar, and upgrade extraction to produce up to 5 distinct flashcards per exchange.

**Architecture:** Schema gains a `subtopic` column on `flashcards`. `FlashcardAgent` grows multi-card extraction (new prompt + tool), a filter-aware `selectForReview`, and a `getTopicsWithSubtopics` query. Two new server routes (`GET /topics`, `POST /flashcard`) expose the tree and filtered fetch. The frontend adds shared types, two new hooks (`useTopics`, `fetchNext` on `useFlashcard`), two new components (`TopicFilterDropdown`, `FlashcardButton`), and wires them into `ChatInput` + `App`.

**Tech Stack:** TypeScript, Node/Express, PostgreSQL, React, Vitest, lucide-react (already installed)

---

## File map

| File | Action |
|---|---|
| `schema.sql` | Add `subtopic TEXT` column to `flashcards` |
| `src/types.ts` | Add `FlashcardFilter`, `TopicTree`; add `subtopic` to `FlashcardCard` |
| `src/flashcard-agent.ts` | New extraction prompt/tool, multi-card `extract()`, `selectForReview(filter?)`, `getTopicsWithSubtopics()` |
| `src/server.ts` | Add `GET /topics`, `POST /flashcard`; extend `AgentServerOptions` |
| `src/start-server.ts` | Wire `getTopics` |
| `src/flashcard-agent.eval.ts` | Add extraction eval block |
| `src/ui/lib/types.ts` | New — `FlashcardFilter`, `TopicTree` (frontend copies) |
| `src/ui/hooks/useTopics.ts` | New — fetch topic tree |
| `src/ui/hooks/useFlashcard.ts` | Add `fetchNext(filter?)` |
| `src/ui/components/TopicFilterDropdown.tsx` | New — nested multiselect popover |
| `src/ui/components/FlashcardButton.tsx` | New — BookOpen icon button |
| `src/ui/components/ChatInput.tsx` | Add dropdown + flashcard button |
| `src/ui/App.tsx` | Add filter state, wire new props |

---

## Task 1: Schema — add subtopic to flashcards

**Files:**
- Modify: `schema.sql`

- [ ] **Step 1: Add the column to `schema.sql`**

Open `schema.sql` and locate the `CREATE TABLE IF NOT EXISTS flashcards` block. Add `subtopic TEXT` after the existing `topic_id` line:

```sql
CREATE TABLE IF NOT EXISTS flashcards (
  id                BIGSERIAL PRIMARY KEY,
  question          TEXT NOT NULL,
  answer            TEXT NOT NULL,
  topic_id          BIGINT REFERENCES topics(id) ON DELETE SET NULL,
  subtopic          TEXT,
  source_message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  ...
```

- [ ] **Step 2: Apply the migration to the running database**

```bash
docker exec tsagent-db psql -U admin -d tsagent -c "ALTER TABLE flashcards ADD COLUMN IF NOT EXISTS subtopic TEXT;"
```

Expected output:
```
ALTER TABLE
```

- [ ] **Step 3: Backfill existing rows from source messages**

```bash
docker exec tsagent-db psql -U admin -d tsagent -c "
UPDATE flashcards f
SET subtopic = m.subtopic
FROM messages m
WHERE f.source_message_id = m.id
  AND f.subtopic IS NULL;"
```

Expected output:
```
UPDATE N
```
(N may be 0 if no flashcards have a source_message_id yet — that's fine.)

- [ ] **Step 4: Verify the column exists**

```bash
docker exec tsagent-db psql -U admin -d tsagent -c "\d flashcards" | grep subtopic
```

Expected: `subtopic | text | ...`

- [ ] **Step 5: Commit**

```bash
git add schema.sql
git commit -m "feat: add subtopic column to flashcards table"
```

---

## Task 2: Types — FlashcardFilter, TopicTree, FlashcardCard.subtopic

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add `FlashcardFilter` and `TopicTree` to `src/types.ts`**

Open `src/types.ts`. Add these two interfaces after the `FlashcardCard` interface (around line 114):

```ts
export interface TopicTree {
  id: number;
  label: string;
  subtopics: string[];
}

export interface FlashcardFilter {
  topicIds?: number[];
  subtopics?: Array<{ topicId: number; subtopic: string }>;
}
```

- [ ] **Step 2: Add `subtopic` to `FlashcardCard`**

Find the existing `FlashcardCard` interface and add `subtopic`:

```ts
export interface FlashcardCard {
  id: number;
  question: string;
  answer: string;
  topicId: number | null;
  topicLabel: string | null;
  subtopic: string | null;
}
```

- [ ] **Step 3: Add `getTopics` to `AgentServerOptions`**

Find `AgentServerOptions` (currently at the bottom of the file) and add the optional getter:

```ts
export interface AgentServerOptions {
  staticDir?: string;
  getHistory?: (limit: number) => Promise<HistoryMessage[]>;
  flashcardAgent?: FlashcardAgent;
  getMindmap?: () => Promise<MindmapGraph>;
  getTopics?: () => Promise<TopicTree[]>;
}
```

- [ ] **Step 4: Type-check**

```bash
npm run typecheck
```

Expected: no errors (existing code that constructs `FlashcardCard` objects may break — fix by adding `subtopic: r.subtopic ?? null` in `_fetchById` in the next task).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts
git commit -m "feat: add FlashcardFilter, TopicTree types; add subtopic to FlashcardCard"
```

---

## Task 3: FlashcardAgent — multi-card extraction

**Files:**
- Modify: `src/flashcard-agent.ts`

The current `extract()` emits at most 1 card via a `save_flashcard` tool. We replace the extraction instructions and tool with a multi-card version.

- [ ] **Step 1: Replace `EXTRACTION_INSTRUCTIONS`**

Find the `EXTRACTION_INSTRUCTIONS` constant and replace it entirely:

```ts
export const EXTRACTION_INSTRUCTIONS = `You are a flashcard extractor for spaced repetition learning.

Given a conversation exchange, extract up to 5 distinct, independently learnable facts as flashcards.

Rules:
- Only extract clear factual claims that are worth memorising.
- Each flashcard must cover a DIFFERENT fact — do not rephrase the same concept twice.
- If the exchange is casual chat, a task request, or contains no clear facts, call save_flashcards with an empty array.
- Questions must be specific and answerable. Answers must be concise and direct.

Steps:
1. Identify all distinct learnable facts in the exchange (max 5).
2. Call save_flashcards with the array of {question, answer} pairs (empty array if none).`;
```

- [ ] **Step 2: Replace `buildExtractionTools` with multi-card version**

Find `buildExtractionTools` and replace the entire function:

```ts
function buildExtractionTools(
  pool: pg.Pool,
  state: { savedCards: Array<{ question: string; answer: string }> },
): FunctionTool[] {
  const saveFlashcards = new FunctionTool(
    async (params) => {
      const raw = params["flashcards"];
      if (!Array.isArray(raw) || raw.length === 0) {
        return JSON.stringify({ saved: 0 });
      }

      const cards = (raw as Array<{ question?: string; answer?: string }>)
        .filter((c) => c.question?.trim() && c.answer?.trim())
        .slice(0, 5);

      state.savedCards = cards.map((c) => ({
        question: c.question!.trim(),
        answer: c.answer!.trim(),
      }));

      return JSON.stringify({ saved: cards.length });
    },
    "save_flashcards",
    "Save an array of flashcard {question, answer} pairs extracted from the exchange. Pass an empty array if no facts found.",
    {
      type: "object",
      properties: {
        flashcards: {
          type: "array",
          description: "Array of {question, answer} objects, max 5",
          items: {
            type: "object",
            properties: {
              question: { type: "string" },
              answer: { type: "string" },
            },
            required: ["question", "answer"],
          },
        },
      },
      required: ["flashcards"],
    },
  );

  return [saveFlashcards];
}
```

- [ ] **Step 3: Update `FlashcardAgent` constructor to use new extraction state**

Find the `FlashcardAgent` class constructor. The `_state` shape needs to grow to hold extracted cards. Replace the class definition opening:

```ts
export class FlashcardAgent extends OpenAIAgent {
  private _pool: pg.Pool;
  private _state: { selectedId: number | null };
  private _extractState: { savedCards: Array<{ question: string; answer: string }> };

  constructor(pool: pg.Pool) {
    const state = { selectedId: null as number | null };
    const extractState = { savedCards: [] as Array<{ question: string; answer: string }> };

    super("flashcard-agent", SELECTION_INSTRUCTIONS, {
      tools: [
        ...buildSelectionTools(pool, state),
        ...buildExtractionTools(pool, extractState),
      ],
      middleware: [new OtelMiddleware("flashcard-agent")],
      streamTokens: false,
    });

    this._pool = pool;
    this._state = state;
    this._extractState = extractState;
  }
```

- [ ] **Step 4: Rewrite `extract()` to persist multiple cards with subtopic**

Find `extract()` and replace it entirely:

```ts
async extract(userMsg: string, assistantMsg: string, sourceMessageId?: number): Promise<void> {
  if (!assistantMsg.trim()) return;

  // Fetch subtopic from source message if we have its id
  let subtopic: string | null = null;
  let topicId: number | null = null;
  if (sourceMessageId != null) {
    const { rows } = await this._pool.query<{ topic_id: number | null; subtopic: string | null }>(
      'SELECT topic_id, subtopic FROM messages WHERE id = $1',
      [sourceMessageId],
    );
    if (rows[0]) {
      topicId = rows[0].topic_id;
      subtopic = rows[0].subtopic;
    }
  }

  this._extractState.savedCards = [];
  this.context.messages = [];
  this.instructions = EXTRACTION_INSTRUCTIONS;

  await this.run(
    `Extract flashcards from this exchange:\n\nUser: "${userMsg}"\nAssistant: "${assistantMsg}"`,
  );

  // Persist each candidate independently, checking for duplicates
  for (const card of this._extractState.savedCards) {
    const isDup = await this._isDuplicate(card.question);
    if (!isDup) {
      await this._pool.query(
        `INSERT INTO flashcards (question, answer, topic_id, subtopic, source_message_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [card.question, card.answer, topicId, subtopic, sourceMessageId ?? null],
      );
    }
  }
}
```

Note: The `%` operator requires `pg_trgm` extension. If not available, only the lower() fallback runs. That is fine — it is a best-effort deduplication.

- [ ] **Step 5: Update `_isDuplicate` to use exact-match only (no pg_trgm required)**

Add this private method to `FlashcardAgent`:

```ts
private async _isDuplicate(question: string): Promise<boolean> {
  const { rows } = await this._pool.query<{ id: number }>(
    `SELECT id FROM flashcards WHERE lower(trim(question)) = lower(trim($1)) LIMIT 1`,
    [question],
  );
  return rows.length > 0;
}
```

- [ ] **Step 6: Update `_fetchById` to return `subtopic`**

Find `_fetchById` and update the query and return value:

```ts
private async _fetchById(id: number): Promise<FlashcardCard | null> {
  const { rows } = await this._pool.query<{
    id: number;
    question: string;
    answer: string;
    topic_id: number | null;
    topic_label: string | null;
    subtopic: string | null;
  }>(
    `SELECT f.id, f.question, f.answer, f.topic_id, f.subtopic, t.label AS topic_label
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
    subtopic: r.subtopic,
  };
}
```

- [ ] **Step 6: Type-check**

```bash
npm run typecheck
```

Fix any errors (likely missing `subtopic` in a few call sites). The `start-server.ts` calls `flashcardAgent.extract(message, lastAssistantContent)` — the new optional `sourceMessageId` param defaults to `undefined` so this still compiles.

- [ ] **Step 7: Commit**

```bash
git add src/flashcard-agent.ts
git commit -m "feat: extract up to 5 distinct flashcards per exchange with subtopic inheritance"
```

---

## Task 4: FlashcardAgent — selectForReview(filter?) and getTopicsWithSubtopics()

**Files:**
- Modify: `src/flashcard-agent.ts`

- [ ] **Step 1: Add import for `FlashcardFilter` and `TopicTree`**

At the top of `src/flashcard-agent.ts`, update the types import:

```ts
import type { FlashcardCard, DueCard, FlashcardFilter, TopicTree } from "./types";
```

- [ ] **Step 2: Update `buildSelectionTools` to close over a mutable `filterRef`**

Instead of reassigning tools at call time, the tool closes over a ref that `selectForReview` sets before calling `run`. Replace the entire `buildSelectionTools` function:

```ts
function buildSelectionTools(
  pool: pg.Pool,
  state: { selectedId: number | null },
  filterRef: { current: FlashcardFilter | undefined },
): FunctionTool[] {
  const getDueFlashcards = new FunctionTool(
    async (params) => {
      const limit = Math.min(Number(params["limit"] ?? 10), 20);
      const filter = filterRef.current;

      const args: unknown[] = [limit];
      const parts: string[] = [];

      if (filter?.topicIds && filter.topicIds.length > 0) {
        parts.push(`f.topic_id = ANY($${args.push(filter.topicIds)}::int[])`);
      }
      if (filter?.subtopics && filter.subtopics.length > 0) {
        for (const { topicId, subtopic } of filter.subtopics) {
          parts.push(`(f.topic_id = $${args.push(topicId)} AND f.subtopic = $${args.push(subtopic)})`);
        }
      }

      const filterClause = parts.length > 0 ? `AND (${parts.join(" OR ")})` : "";

      try {
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

        const cards: DueCard[] = rows.map((r) => ({
          id: r.id,
          question: r.question,
          topicId: r.topic_id,
          topicLabel: r.topic_label,
          lastScore: r.last_score,
          daysOverdue: Math.max(
            0,
            Math.floor((Date.now() - new Date(r.next_due_at).getTime()) / 86_400_000),
          ),
        }));
        return JSON.stringify(cards);
      } catch (err) {
        return JSON.stringify({ error: String(err) });
      }
    },
    "get_due_flashcards",
    "Get flashcards due for review. Returns [{id, question, topicId, topicLabel, lastScore, daysOverdue}].",
    {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max cards to return (default 10)" },
      },
      required: [],
    },
  );

  const selectCard = new FunctionTool(
    (params) => {
      const raw = params["id"];
      state.selectedId = raw != null && raw !== "null" ? Number(raw) : null;
      return JSON.stringify({ success: true });
    },
    "select_card",
    "Record the chosen flashcard ID for review. Pass id=null if no cards are available.",
    {
      type: "object",
      properties: {
        id: { description: "Flashcard ID to review, or null if none available" },
      },
      required: ["id"],
    },
  );

  return [getDueFlashcards, selectCard];
}
```

- [ ] **Step 3: Update `FlashcardAgent` constructor and `selectForReview`**

Update the constructor to create `_filterRef` and pass it to `buildSelectionTools`:

```ts
export class FlashcardAgent extends OpenAIAgent {
  private _pool: pg.Pool;
  private _state: { selectedId: number | null };
  private _extractState: { savedCards: Array<{ question: string; answer: string }> };
  private _filterRef: { current: FlashcardFilter | undefined };

  constructor(pool: pg.Pool) {
    const state = { selectedId: null as number | null };
    const extractState = { savedCards: [] as Array<{ question: string; answer: string }> };
    const filterRef = { current: undefined as FlashcardFilter | undefined };

    super("flashcard-agent", SELECTION_INSTRUCTIONS, {
      tools: [
        ...buildSelectionTools(pool, state, filterRef),
        ...buildExtractionTools(pool, extractState),
      ],
      middleware: [new OtelMiddleware("flashcard-agent")],
      streamTokens: false,
    });

    this._pool = pool;
    this._state = state;
    this._extractState = extractState;
    this._filterRef = filterRef;
  }
```

Replace `selectForReview`:

```ts
async selectForReview(filter?: FlashcardFilter): Promise<FlashcardCard | null> {
  this._filterRef.current = filter;
  this.context.messages = [];
  this.instructions = SELECTION_INSTRUCTIONS;
  this._state.selectedId = null;

  const hasFilter =
    (filter?.topicIds?.length ?? 0) > 0 ||
    (filter?.subtopics?.length ?? 0) > 0;

  const prompt = hasFilter
    ? `Select a flashcard for review using the active topic filter. Call get_due_flashcards, then select_card.`
    : `Select a flashcard for review. Call get_due_flashcards, then select_card.`;

  await this.run(prompt);
  this._filterRef.current = undefined;

  if (this._state.selectedId === null) return null;
  return this._fetchById(this._state.selectedId);
}
```

- [ ] **Step 5: Add `getTopicsWithSubtopics()`**

Add this method to `FlashcardAgent` after `selectForReview`:

```ts
async getTopicsWithSubtopics(): Promise<TopicTree[]> {
  const { rows } = await this._pool.query<{
    id: number;
    label: string;
    subtopics: string[] | null;
  }>(
    `SELECT t.id, t.label,
       array_agg(DISTINCT f.subtopic) FILTER (WHERE f.subtopic IS NOT NULL) AS subtopics
     FROM topics t
     JOIN flashcards f ON f.topic_id = t.id
     GROUP BY t.id, t.label
     ORDER BY t.label`,
  );
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    subtopics: r.subtopics ?? [],
  }));
}
```

- [ ] **Step 6: Type-check**

```bash
npm run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add src/flashcard-agent.ts src/agent.ts
git commit -m "feat: selectForReview accepts FlashcardFilter; add getTopicsWithSubtopics"
```

---

## Task 5: Server routes — GET /topics and POST /flashcard

**Files:**
- Modify: `src/server.ts`
- Modify: `src/start-server.ts`

- [ ] **Step 1: Add `GET /topics` OPTIONS handler to `src/server.ts`**

After the existing `app.options("/mindmap", ...)` block, add:

```ts
app.options("/topics", (_req: Request, res: Response) => {
  res.sendStatus(204);
});
```

- [ ] **Step 2: Add `GET /topics` route**

After the `app.get("/mindmap", ...)` handler, add:

```ts
app.get("/topics", async (_req: Request, res: Response) => {
  if (!options.getTopics) {
    res.status(404).json({ error: "Topics not configured" });
    return;
  }
  try {
    res.json(await options.getTopics());
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
```

- [ ] **Step 3: Add `POST /flashcard` route**

After the existing `app.get("/flashcard", ...)` handler, add:

```ts
app.post("/flashcard", async (req: Request, res: Response) => {
  if (!options.flashcardAgent) {
    res.status(404).json({ error: "Flashcard not configured" });
    return;
  }
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
  try {
    const card = await options.flashcardAgent.selectForReview(filter);
    res.json(card ?? null);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
```

- [ ] **Step 4: Add `FlashcardFilter` import to `src/server.ts`**

At the top of `src/server.ts`, update the import from `./types`:

```ts
import { AgentServerOptions, FlashcardFilter } from "./types";
```

- [ ] **Step 5: Wire `getTopics` in `src/start-server.ts`**

Find the block in `startServer()` where `flashcardAgent` is created, and add:

```ts
flashcardAgent = new FlashcardAgent(pool);
// add this line directly after:
const getTopics = () => flashcardAgent!.getTopicsWithSubtopics();
```

Then find the `createAgentServer(...)` call and add `getTopics` to the options:

```ts
const app = createAgentServer(
  async function* (message, signal) { ... },
  {
    staticDir: path.join(__dirname, "../dist/ui"),
    getHistory,
    flashcardAgent,
    getMindmap,
    getTopics,   // ← add this
  },
);
```

- [ ] **Step 6: Type-check**

```bash
npm run typecheck
```

- [ ] **Step 7: Smoke test the new endpoints (requires running server)**

```bash
# Start the server in one terminal
npm run dev

# In another terminal
curl http://localhost:3000/topics
# Expected: [] or an array of { id, label, subtopics }

curl -s -X POST http://localhost:3000/flashcard \
  -H 'Content-Type: application/json' \
  -d '{}' | head -c 200
# Expected: null or a flashcard object
```

- [ ] **Step 8: Commit**

```bash
git add src/server.ts src/start-server.ts
git commit -m "feat: add GET /topics and POST /flashcard with FlashcardFilter support"
```

---

## Task 6: Extraction eval

**Files:**
- Modify: `src/flashcard-agent.eval.ts`

- [ ] **Step 1: Add extraction scenario type and eval block to `flashcard-agent.eval.ts`**

Open `src/flashcard-agent.eval.ts`. At the bottom, after the existing `main()` call, add:

```ts
// ---------------------------------------------------------------------------
// Extraction eval
// ---------------------------------------------------------------------------

interface ExtractionScenario {
  id: string;
  description: string;
  userMsg: string;
  assistantMsg: string;
  expectedBehavior: string;
  minCards: number;
  maxCards: number;
}

function createExtractionEvalAgent(): {
  agent: OpenAIAgent;
  getSavedCards: () => Array<{ question: string; answer: string }>;
} {
  const state = { savedCards: [] as Array<{ question: string; answer: string }> };

  const saveFlashcards = new FunctionTool(
    (params) => {
      const raw = params["flashcards"];
      if (!Array.isArray(raw)) {
        state.savedCards = [];
        return JSON.stringify({ saved: 0 });
      }
      state.savedCards = (raw as Array<{ question?: string; answer?: string }>)
        .filter((c) => c.question?.trim() && c.answer?.trim())
        .slice(0, 5)
        .map((c) => ({ question: c.question!.trim(), answer: c.answer!.trim() }));
      return JSON.stringify({ saved: state.savedCards.length });
    },
    "save_flashcards",
    "Save an array of flashcard {question, answer} pairs extracted from the exchange. Pass an empty array if no facts found.",
    {
      type: "object",
      properties: {
        flashcards: {
          type: "array",
          items: {
            type: "object",
            properties: {
              question: { type: "string" },
              answer: { type: "string" },
            },
            required: ["question", "answer"],
          },
        },
      },
      required: ["flashcards"],
    },
  );

  const agent = new OpenAIAgent("flashcard-extraction-eval", EXTRACTION_INSTRUCTIONS, {
    tools: [saveFlashcards],
    streamTokens: false,
  });

  return { agent, getSavedCards: () => state.savedCards };
}

// Count is validated inline via `inRange` in the run() output — no LLM judge needed.

class DistinctnessJudge extends LLMJudge {
  criteriaPrompt =
    "Evaluate whether all extracted flashcards cover genuinely different facts. Score 0 if any two cards are rephrasing of the same concept. Score 1 if all cards cover distinct, non-overlapping facts.";
}

class QualityJudge extends LLMJudge {
  criteriaPrompt =
    "Evaluate whether the flashcard questions are clear, specific, and independently answerable, and whether the answers are accurate, concise, and directly responsive to the question. Score 0 if any card has a vague question or an inaccurate/incomplete answer.";
}

const extractionScenarios: ExtractionScenario[] = [
  {
    id: "multi-fact-rich",
    description: "Rich compound interest explanation with 5+ distinct facts",
    userMsg: "Can you explain compound interest in detail?",
    assistantMsg: `Compound interest is interest calculated on both the initial principal and the accumulated interest from previous periods. The formula is A = P(1 + r/n)^(nt), where P is principal, r is annual interest rate, n is compounding frequency, and t is time in years. A useful shortcut is the Rule of 72: divide 72 by the annual interest rate to estimate how many years it takes for money to double. More frequent compounding (daily vs annually) yields slightly more growth. Compound interest differs from simple interest, which is calculated only on the principal.`,
    expectedBehavior: "Extracts ≥ 3 distinct flashcards covering the definition, formula, Rule of 72, compounding frequency, and/or the comparison to simple interest.",
    minCards: 3,
    maxCards: 5,
  },
  {
    id: "single-fact-simple",
    description: "Single clear fact — capital of France",
    userMsg: "What is the capital of France?",
    assistantMsg: "The capital of France is Paris.",
    expectedBehavior: "Extracts exactly 1 flashcard.",
    minCards: 1,
    maxCards: 1,
  },
  {
    id: "no-facts",
    description: "Casual exchange with no learnable facts",
    userMsg: "Thanks, that was really helpful!",
    assistantMsg: "You're welcome! Let me know if you have any other questions.",
    expectedBehavior: "Extracts 0 flashcards — no learnable fact present.",
    minCards: 0,
    maxCards: 0,
  },
  {
    id: "near-duplicate-facts",
    description: "Exchange that repeats the same fact in two phrasings",
    userMsg: "What does DNA stand for?",
    assistantMsg: "DNA stands for deoxyribonucleic acid. In other words, deoxyribonucleic acid is the molecule we call DNA.",
    expectedBehavior: "Extracts exactly 1 flashcard — the two phrasings are the same fact.",
    minCards: 1,
    maxCards: 1,
  },
  {
    id: "max-cap",
    description: "Extremely information-dense exchange touching 10+ facts",
    userMsg: "Tell me everything about the solar system.",
    assistantMsg: `The solar system formed about 4.6 billion years ago from a giant molecular cloud. The Sun contains 99.86% of the solar system's mass. There are 8 planets: Mercury, Venus, Earth, Mars, Jupiter, Saturn, Uranus, Neptune. The asteroid belt lies between Mars and Jupiter. Jupiter is the largest planet. Neptune is the farthest from the Sun. Earth is the only known planet with life. Mars has the tallest volcano, Olympus Mons. Saturn's rings are made mostly of ice and rock. Light from the Sun takes about 8 minutes to reach Earth.`,
    expectedBehavior: "Extracts exactly 5 flashcards (the maximum cap), despite more facts being available.",
    minCards: 5,
    maxCards: 5,
  },
];

async function mainExtraction() {
  await runEval({
    agentName: "FlashcardAgent:extraction",
    scenarios: extractionScenarios,
    judges: [
      new DistinctnessJudge(),
      new QualityJudge(),
    ],
    run: async (scenario) => {
      const { agent, getSavedCards } = createExtractionEvalAgent();
      await agent.run(
        `Extract flashcards from this exchange:\n\nUser: "${scenario.userMsg}"\nAssistant: "${scenario.assistantMsg}"`,
      );
      const cards = getSavedCards();
      const count = cards.length;
      const inRange = count >= scenario.minCards && count <= scenario.maxCards;
      return JSON.stringify({ count, inRange, cards });
    },
    buildContext: (scenario) =>
      `Scenario: ${scenario.description}\nExpected: ${scenario.expectedBehavior}\nExpected card count: [${scenario.minCards}, ${scenario.maxCards}]`,
    outputDir: __dirname,
  });
}

mainExtraction().catch(console.error);
```

- [ ] **Step 2: Register the extraction eval in `src/run-eval.ts`**

Open `src/run-eval.ts` and update the `agents` map:

```ts
const agents: Record<string, string> = {
  FlashcardAgent: "./flashcard-agent.eval",
  "FlashcardAgent:extraction": "./flashcard-agent.eval",
  MindmapAgent: "./mindmap-agent.eval",
};
```

(Both keys point to the same file; `mainExtraction` is called at module load.)

- [ ] **Step 3: Type-check**

```bash
npm run typecheck
```

- [ ] **Step 4: Run the extraction eval (requires OPENAI_API_KEY)**

```bash
npm run eval FlashcardAgent:extraction
```

Expected: eval output printed per scenario. Not all scenarios need to pass perfectly on first run — this is a quality check, not a hard gate.

- [ ] **Step 5: Commit**

```bash
git add src/flashcard-agent.eval.ts src/run-eval.ts
git commit -m "feat: add multi-card extraction eval with 5 scenarios"
```

---

## Task 7: Frontend shared types + hooks

**Files:**
- Create: `src/ui/lib/types.ts`
- Modify: `src/ui/hooks/useFlashcard.ts`
- Create: `src/ui/hooks/useTopics.ts`

- [ ] **Step 1: Create `src/ui/lib/types.ts`**

```ts
// src/ui/lib/types.ts
export interface TopicTree {
  id: number;
  label: string;
  subtopics: string[];
}

export interface FlashcardFilter {
  topicIds?: number[];
  subtopics?: Array<{ topicId: number; subtopic: string }>;
}
```

- [ ] **Step 2: Create `src/ui/hooks/useTopics.ts`**

```ts
// src/ui/hooks/useTopics.ts
import { useEffect, useState } from "react";
import type { TopicTree } from "@/lib/types";

export function useTopics(): { topics: TopicTree[]; loading: boolean } {
  const [topics, setTopics] = useState<TopicTree[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/topics")
      .then((r) => (r.ok ? r.json() : Promise.resolve([])))
      .then((data: TopicTree[]) => setTopics(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return { topics, loading };
}
```

- [ ] **Step 3: Add `fetchNext` to `src/ui/hooks/useFlashcard.ts`**

Open the file. Add `FlashcardFilter` import at the top:

```ts
import type { FlashcardFilter } from "@/lib/types";
```

Then add `fetchNext` inside the `useFlashcard` function body, after the `submitScore` callback:

```ts
const fetchNext = useCallback(async (filter?: FlashcardFilter) => {
  const res = await fetch("/flashcard", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(filter ?? {}),
  }).catch(() => null);
  if (!res?.ok) return;
  const data = (await res.json()) as FlashcardData | null;
  if (data?.id) {
    setCard(data);
    setPhase("question");
  }
}, []);
```

Update the return value of `useFlashcard` to include `fetchNext`:

```ts
return { card, phase, reveal, submitScore, fetchNext };
```

- [ ] **Step 4: Type-check**

```bash
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/ui/lib/types.ts src/ui/hooks/useTopics.ts src/ui/hooks/useFlashcard.ts
git commit -m "feat: add useTopics hook and fetchNext to useFlashcard"
```

---

## Task 8: TopicFilterDropdown component

**Files:**
- Create: `src/ui/components/TopicFilterDropdown.tsx`

- [ ] **Step 1: Create the component**

```tsx
// src/ui/components/TopicFilterDropdown.tsx
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

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const selectedCount =
    (filter.topicIds?.length ?? 0) + (filter.subtopics?.length ?? 0);

  const isTopicSelected = (id: number) =>
    filter.topicIds?.includes(id) ?? false;

  const isSubtopicSelected = (topicId: number, subtopic: string) =>
    filter.subtopics?.some((s) => s.topicId === topicId && s.subtopic === subtopic) ?? false;

  const toggleTopic = (id: number) => {
    const topicIds = filter.topicIds ?? [];
    const next = topicIds.includes(id)
      ? topicIds.filter((x) => x !== id)
      : [...topicIds, id];
    onChange({ ...filter, topicIds: next.length > 0 ? next : undefined });
  };

  const toggleSubtopic = (topicId: number, subtopic: string) => {
    const subs = filter.subtopics ?? [];
    const exists = subs.some((s) => s.topicId === topicId && s.subtopic === subtopic);
    const next = exists
      ? subs.filter((s) => !(s.topicId === topicId && s.subtopic === subtopic))
      : [...subs, { topicId, subtopic }];
    onChange({ ...filter, subtopics: next.length > 0 ? next : undefined });
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
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 12px",
                  cursor: "pointer",
                }}
              >
                {topic.subtopics.length > 0 && (
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
                {topic.subtopics.length === 0 && <span style={{ width: 12 }} />}
                <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 13, color: "var(--foreground)", userSelect: "none", flex: 1 }}>
                  <input
                    type="checkbox"
                    checked={isTopicSelected(topic.id)}
                    onChange={() => toggleTopic(topic.id)}
                    style={{ cursor: "pointer" }}
                  />
                  {topic.label}
                </label>
              </div>
              {expanded.has(topic.id) && topic.subtopics.map((sub) => (
                <label
                  key={sub}
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
                    checked={isSubtopicSelected(topic.id, sub)}
                    onChange={() => toggleSubtopic(topic.id, sub)}
                    style={{ cursor: "pointer" }}
                  />
                  {sub}
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

- [ ] **Step 2: Type-check**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/ui/components/TopicFilterDropdown.tsx
git commit -m "feat: add TopicFilterDropdown nested multiselect component"
```

---

## Task 9: FlashcardButton component

**Files:**
- Create: `src/ui/components/FlashcardButton.tsx`

- [ ] **Step 1: Create the component**

```tsx
// src/ui/components/FlashcardButton.tsx
import { BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  onClick: () => void;
  disabled: boolean;
}

export function FlashcardButton({ onClick, disabled }: Props) {
  return (
    <Button
      type="button"
      size="icon"
      variant="outline"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? "Finish current card first" : "Get a flashcard"}
    >
      <BookOpen className="h-4 w-4" />
    </Button>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/ui/components/FlashcardButton.tsx
git commit -m "feat: add FlashcardButton component"
```

---

## Task 10: Wire everything into ChatInput and App

**Files:**
- Modify: `src/ui/components/ChatInput.tsx`
- Modify: `src/ui/App.tsx`

- [ ] **Step 1: Update `ChatInput` props and layout**

Replace the entire `src/ui/components/ChatInput.tsx`:

```tsx
import { FormEvent, KeyboardEvent, useRef } from "react";
import { Send, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TopicFilterDropdown } from "@/components/TopicFilterDropdown";
import { FlashcardButton } from "@/components/FlashcardButton";
import type { TopicTree, FlashcardFilter } from "@/lib/types";

interface ChatInputProps {
  onSend: (message: string) => void;
  onCancel: () => void;
  isStreaming: boolean;
  topics: TopicTree[];
  flashcardFilter: FlashcardFilter;
  onFilterChange: (filter: FlashcardFilter) => void;
  onFetchFlashcard: () => void;
  isFlashcardActive: boolean;
}

export function ChatInput({
  onSend,
  onCancel,
  isStreaming,
  topics,
  flashcardFilter,
  onFilterChange,
  onFetchFlashcard,
  isFlashcardActive,
}: ChatInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = () => {
    const value = inputRef.current?.value.trim();
    if (!value || isStreaming) return;
    inputRef.current!.value = "";
    onSend(value);
  };

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="border-t border-border bg-background px-4 py-3">
      <div className="mx-auto flex max-w-3xl items-center gap-2">
        <Input
          ref={inputRef}
          placeholder="Ask something…"
          onKeyDown={handleKey}
          disabled={isStreaming}
          autoFocus
          className="flex-1"
        />

        <TopicFilterDropdown
          topics={topics}
          filter={flashcardFilter}
          onChange={onFilterChange}
        />

        <FlashcardButton
          onClick={onFetchFlashcard}
          disabled={isFlashcardActive}
        />

        {isStreaming ? (
          <Button variant="destructive" size="icon" onClick={onCancel} title="Stop">
            <Square className="h-4 w-4 fill-current" />
          </Button>
        ) : (
          <Button size="icon" onClick={submit} title="Send">
            <Send className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update `App.tsx`**

Replace the entire `src/ui/App.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { useChat } from "@/hooks/useChat";
import { useFlashcard } from "@/hooks/useFlashcard";
import { useTopics } from "@/hooks/useTopics";
import { Message } from "@/components/Message";
import { ChatInput } from "@/components/ChatInput";
import { FlashcardWidget } from "@/components/FlashcardWidget";
import { Mindmap } from "@/components/Mindmap";
import type { FlashcardFilter } from "@/lib/types";

export function App() {
  const { messages, isStreaming, sendMessage, cancel } = useChat();
  const { card, phase, reveal, submitScore, fetchNext } = useFlashcard();
  const { topics } = useTopics();
  const bottomRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<"chat" | "mindmap">("chat");
  const [flashcardFilter, setFlashcardFilter] = useState<FlashcardFilter>({});

  useEffect(() => {
    if (view === "chat")
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, view]);

  if (view === "mindmap") {
    return (
      <div className="flex h-dvh flex-col bg-background text-foreground">
        <header className="flex-shrink-0 border-b border-border px-6 py-4 flex items-center gap-4">
          <button
            onClick={() => setView("chat")}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            ← Back
          </button>
          <span className="text-xs uppercase tracking-widest text-muted-foreground">
            Mindmap
          </span>
        </header>
        <div className="flex-1 overflow-hidden">
          <Mindmap />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex-shrink-0 border-b border-border px-6 py-4 flex items-center justify-between">
        <span className="text-xs uppercase tracking-widest text-muted-foreground">
          Agent Chat
        </span>
        <button
          onClick={() => setView("mindmap")}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          🗺 Mindmap
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-5">
          {messages.length === 0 && (
            <p className="text-center text-sm text-muted-foreground">
              Ask anything…
            </p>
          )}
          {messages.map((msg) => (
            <Message key={msg.id} {...msg} />
          ))}
          {card && (
            <FlashcardWidget
              card={card}
              phase={phase}
              onReveal={reveal}
              onScore={submitScore}
            />
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <ChatInput
        onSend={sendMessage}
        onCancel={cancel}
        isStreaming={isStreaming}
        topics={topics}
        flashcardFilter={flashcardFilter}
        onFilterChange={setFlashcardFilter}
        onFetchFlashcard={() => fetchNext(flashcardFilter)}
        isFlashcardActive={phase === "question" || phase === "answer"}
      />
    </div>
  );
}
```

- [ ] **Step 3: Type-check**

```bash
npm run typecheck
```

- [ ] **Step 4: Run all tests**

```bash
npm test
```

Expected: all existing tests pass.

- [ ] **Step 5: Build**

```bash
npm run build
```

Expected: clean build with no errors.

- [ ] **Step 6: Manual smoke test**

Start the server and open the browser:

```bash
npm run dev
```

Verify:
1. The chat input bar shows a "Topics" button, a `BookOpen` button, and the Send button
2. Clicking "Topics" opens a dropdown with the topic tree
3. With no filter selected, clicking `BookOpen` fetches a flashcard from any topic
4. Selecting a topic/subtopic and clicking `BookOpen` fetches a card scoped to that selection
5. `BookOpen` is disabled while a card is displayed
6. The filter badge count increments as you check topics

- [ ] **Step 7: Commit**

```bash
git add src/ui/components/ChatInput.tsx src/ui/App.tsx
git commit -m "feat: wire TopicFilterDropdown and FlashcardButton into chat input bar"
```
