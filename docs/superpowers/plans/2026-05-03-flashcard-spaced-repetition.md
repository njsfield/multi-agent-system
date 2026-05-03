# Flashcard Spaced Repetition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add spaced repetition flashcards to the chat UI — on every page load, an inline flashcard drawn from conversation history appears at the top of the message list; the user reveals the answer and rates recall using SM-2 scheduling.

**Architecture:** A per-turn `FlashcardExtractor` fires-and-forgets after each agent response to extract Q&A pairs, deduplicate via embeddings, and stamp a mindmap topic. At session start, `GET /flashcard` runs `FlashcardSelectionAgent` (two tools: mindmap topics + due cards) to pick the best card. SM-2 state lives directly on the `flashcards` row and is updated via `POST /flashcard/:id/review`.

**Tech Stack:** TypeScript, Express, PostgreSQL + pgvector, OpenAI SDK (gpt-4o-mini + text-embedding-3-small), React + Tailwind CSS, Vitest

**Pre-requisite:** The mindmap feature (`feature/mindmap`) must be merged before this work — the `mindmap_cache` table and its `graph` JSONB shape are depended on by `FlashcardExtractor.findClosestTopic()` and `FlashcardSelectionAgent.get_mindmap_topics`.

---

## File Map

### Created
| File | Responsibility |
|---|---|
| `src/flashcard-service.ts` | `applySm2()` pure function + `FlashcardService` (getDueCards, applyReview, getById); exports `FlashcardCard`, `DueCard`, `Sm2State` |
| `src/flashcard-service.test.ts` | Unit tests for SM-2 and service methods |
| `src/flashcard-extractor.ts` | Per-turn extraction pipeline (LLM extract → embed → dedup → topic stamp → insert) |
| `src/flashcard-extractor.test.ts` | Unit tests for extraction pipeline |
| `src/flashcard-agent.ts` | Exported `FLASHCARD_AGENT_INSTRUCTIONS` + `createFlashcardSelectionAgent()` factory |
| `src/ui/hooks/useFlashcard.ts` | React hook: fetch card on mount, manage phase state, reveal + submitScore |
| `src/ui/components/FlashcardWidget.tsx` | Inline flashcard UI (question → answer → done phases) |
| `src/exercises/flashcard-eval/types.ts` | `FlashcardScenario`, `JudgeScore`, `EvalResult` |
| `src/exercises/flashcard-eval/scenarios.ts` | 5 canned scenarios with mock tool responses |
| `src/exercises/flashcard-eval/judges.ts` | `SelectionReasoningJudge`, `PriorityJudge`, `EdgeCaseJudge` |
| `src/exercises/flashcard-eval/report.ts` | `renderReport()` → self-contained HTML with Chart.js |
| `src/exercises/flashcard-eval/index.ts` | Entrypoint: runs scenarios → agents → judges → writes report.html |

### Modified
| File | Change |
|---|---|
| `schema.sql` | Append `flashcards` and `flashcard_reviews` tables |
| `src/types.ts` | Extend `AgentServerOptions` with `getFlashcard` and `reviewFlashcard` |
| `src/server.ts` | Add `/flashcard` (GET) and `/flashcard/:id/review` (POST) endpoints + OPTIONS preflight |
| `vite.config.ts` | Add `/flashcard` dev proxy |
| `src/ui/App.tsx` | Wire in `useFlashcard` hook and `FlashcardWidget` |
| `examples/api-server.ts` | Instantiate `FlashcardService`, `FlashcardExtractor`, `FlashcardSelectionAgent`; wrap stream factory |

**Type ownership:** `FlashcardCard` and `DueCard` are defined and exported from `src/flashcard-service.ts`. `AgentServerOptions` in `src/types.ts` imports `FlashcardCard` from there.

---

## Task 1: Schema migration

**Files:**
- Modify: `schema.sql`

- [ ] **Step 1: Append tables to `schema.sql`**

Add the following after the existing `CREATE INDEX ON message_embeddings` line:

```sql
CREATE TABLE flashcards (
  id                BIGSERIAL PRIMARY KEY,
  question          TEXT NOT NULL,
  answer            TEXT NOT NULL,
  topic_label       TEXT,
  source_message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  embedding         VECTOR(1536),
  interval_days     INT NOT NULL DEFAULT 1,
  ease_factor       FLOAT NOT NULL DEFAULT 2.5,
  repetitions       INT NOT NULL DEFAULT 0,
  next_due_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_reviewed_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON flashcards USING hnsw (embedding vector_cosine_ops);

CREATE TABLE flashcard_reviews (
  id           BIGSERIAL PRIMARY KEY,
  flashcard_id BIGINT NOT NULL REFERENCES flashcards(id) ON DELETE CASCADE,
  score        TEXT NOT NULL CHECK (score IN ('very_easy','easy','hard','fail')),
  sm2_quality  INT NOT NULL,
  reviewed_at  TIMESTAMPTZ DEFAULT now()
);
```

- [ ] **Step 2: Run migration against local database**

```bash
psql postgresql://admin:postgres@localhost/tsagent -c "
CREATE TABLE flashcards (
  id                BIGSERIAL PRIMARY KEY,
  question          TEXT NOT NULL,
  answer            TEXT NOT NULL,
  topic_label       TEXT,
  source_message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  embedding         VECTOR(1536),
  interval_days     INT NOT NULL DEFAULT 1,
  ease_factor       FLOAT NOT NULL DEFAULT 2.5,
  repetitions       INT NOT NULL DEFAULT 0,
  next_due_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_reviewed_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON flashcards USING hnsw (embedding vector_cosine_ops);
CREATE TABLE flashcard_reviews (
  id           BIGSERIAL PRIMARY KEY,
  flashcard_id BIGINT NOT NULL REFERENCES flashcards(id) ON DELETE CASCADE,
  score        TEXT NOT NULL CHECK (score IN ('very_easy','easy','hard','fail')),
  sm2_quality  INT NOT NULL,
  reviewed_at  TIMESTAMPTZ DEFAULT now()
);"
```

Expected output: `CREATE TABLE`, `CREATE INDEX`, `CREATE TABLE`

- [ ] **Step 3: Commit**

```bash
git add schema.sql
git commit -m "feat: add flashcards and flashcard_reviews tables"
```

---

## Task 2: FlashcardService + SM-2 (TDD)

**Files:**
- Create: `src/flashcard-service.ts`
- Create: `src/flashcard-service.test.ts`

- [ ] **Step 1: Write failing tests — create `src/flashcard-service.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { applySm2, FlashcardService } from './flashcard-service';
import type pg from 'pg';

// ── applySm2 ────────────────────────────────────────────────────────────────

describe('applySm2', () => {
  it('fail (quality 0) resets repetitions to 0 and sets interval to 1', () => {
    const result = applySm2({ intervalDays: 6, easeFactor: 2.5, repetitions: 2 }, 0);
    expect(result.repetitions).toBe(0);
    expect(result.intervalDays).toBe(1);
  });

  it('hard (quality 2) also resets repetitions', () => {
    const result = applySm2({ intervalDays: 6, easeFactor: 2.5, repetitions: 2 }, 2);
    expect(result.repetitions).toBe(0);
    expect(result.intervalDays).toBe(1);
  });

  it('easy (quality 4) on first review sets interval to 1 and increments repetitions', () => {
    const result = applySm2({ intervalDays: 1, easeFactor: 2.5, repetitions: 0 }, 4);
    expect(result.intervalDays).toBe(1);
    expect(result.repetitions).toBe(1);
  });

  it('easy on second review sets interval to 6', () => {
    const result = applySm2({ intervalDays: 1, easeFactor: 2.5, repetitions: 1 }, 4);
    expect(result.intervalDays).toBe(6);
    expect(result.repetitions).toBe(2);
  });

  it('easy on third review multiplies interval by ease_factor', () => {
    const result = applySm2({ intervalDays: 6, easeFactor: 2.5, repetitions: 2 }, 4);
    expect(result.intervalDays).toBe(15); // round(6 * 2.5)
    expect(result.repetitions).toBe(3);
  });

  it('very_easy (quality 5) increases ease_factor above 2.5', () => {
    const result = applySm2({ intervalDays: 1, easeFactor: 2.5, repetitions: 0 }, 5);
    expect(result.easeFactor).toBeGreaterThan(2.5);
  });

  it('repeated fails floor ease_factor at 1.3', () => {
    const result = applySm2({ intervalDays: 1, easeFactor: 1.3, repetitions: 0 }, 0);
    expect(result.easeFactor).toBeCloseTo(1.3);
  });

  it('nextDueAt is approximately intervalDays from now', () => {
    const result = applySm2({ intervalDays: 6, easeFactor: 2.5, repetitions: 2 }, 4);
    const expectedMs = result.intervalDays * 24 * 60 * 60 * 1000;
    const actualMs = result.nextDueAt.getTime() - Date.now();
    expect(actualMs).toBeGreaterThan(expectedMs - 5000);
    expect(actualMs).toBeLessThan(expectedMs + 5000);
  });
});

// ── FlashcardService ────────────────────────────────────────────────────────

function makePool(queryImpl: ReturnType<typeof vi.fn> = vi.fn()) {
  return { query: queryImpl } as unknown as pg.Pool;
}

describe('FlashcardService', () => {
  describe('getDueCards', () => {
    it('returns mapped DueCard objects from query results', async () => {
      const pastDue = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      const query = vi.fn().mockResolvedValue({
        rows: [{
          id: 1,
          question: 'What is the capital of France?',
          topic_label: 'Geography',
          last_score: 'hard',
          interval_days: 1,
          next_due_at: pastDue,
        }],
      });
      const service = new FlashcardService(makePool(query));
      const cards = await service.getDueCards(10);

      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({
        id: 1,
        question: 'What is the capital of France?',
        topicLabel: 'Geography',
        lastScore: 'hard',
      });
      expect(cards[0]!.daysOverdue).toBeGreaterThanOrEqual(1);
    });
  });

  describe('applyReview', () => {
    it('updates flashcard SM-2 state and inserts a review record', async () => {
      const query = vi.fn()
        .mockResolvedValueOnce({ rows: [{ interval_days: 1, ease_factor: 2.5, repetitions: 0 }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });
      const service = new FlashcardService(makePool(query));

      await service.applyReview(1, 'easy');

      expect(query).toHaveBeenCalledTimes(3);
      expect(String(query.mock.calls[1]![0])).toMatch(/UPDATE flashcards/);
      expect(String(query.mock.calls[2]![0])).toMatch(/INSERT INTO flashcard_reviews/);
    });

    it('throws for unknown score', async () => {
      const service = new FlashcardService(makePool());
      await expect(service.applyReview(1, 'oops')).rejects.toThrow('Invalid score: oops');
    });
  });

  describe('getById', () => {
    it('returns card with answer when found', async () => {
      const query = vi.fn().mockResolvedValue({
        rows: [{ id: 1, question: 'Q?', answer: 'A!', topic_label: 'Topic' }],
      });
      const service = new FlashcardService(makePool(query));
      const card = await service.getById(1);
      expect(card).toEqual({ id: 1, question: 'Q?', answer: 'A!', topicLabel: 'Topic' });
    });

    it('returns null when not found', async () => {
      const query = vi.fn().mockResolvedValue({ rows: [] });
      const service = new FlashcardService(makePool(query));
      expect(await service.getById(999)).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run src/flashcard-service.test.ts
```

Expected: multiple failures — "Cannot find module './flashcard-service'"

- [ ] **Step 3: Implement `src/flashcard-service.ts`**

```typescript
import pg from 'pg';

export interface Sm2State {
  intervalDays: number;
  easeFactor: number;
  repetitions: number;
}

export interface DueCard {
  id: number;
  question: string;
  topicLabel: string | null;
  lastScore: string | null;
  daysOverdue: number;
}

export interface FlashcardCard {
  id: number;
  question: string;
  answer: string;
  topicLabel: string | null;
}

const SCORE_TO_QUALITY: Record<string, number> = {
  fail: 0,
  hard: 2,
  easy: 4,
  very_easy: 5,
};

export function applySm2(state: Sm2State, quality: number): Sm2State & { nextDueAt: Date } {
  let { intervalDays, easeFactor, repetitions } = state;

  if (quality < 3) {
    repetitions = 0;
    intervalDays = 1;
  } else {
    if (repetitions === 0) intervalDays = 1;
    else if (repetitions === 1) intervalDays = 6;
    else intervalDays = Math.round(intervalDays * easeFactor);
    repetitions++;
  }

  easeFactor += 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02);
  easeFactor = Math.max(1.3, easeFactor);

  const nextDueAt = new Date();
  nextDueAt.setDate(nextDueAt.getDate() + intervalDays);

  return { intervalDays, easeFactor, repetitions, nextDueAt };
}

export class FlashcardService {
  constructor(private pool: pg.Pool) {}

  async getDueCards(limit = 10): Promise<DueCard[]> {
    const { rows } = await this.pool.query<{
      id: number;
      question: string;
      topic_label: string | null;
      last_score: string | null;
      interval_days: number;
      next_due_at: string;
    }>(
      `SELECT f.id, f.question, f.topic_label, f.interval_days, f.next_due_at,
              r.score AS last_score
       FROM flashcards f
       LEFT JOIN LATERAL (
         SELECT score FROM flashcard_reviews
         WHERE flashcard_id = f.id
         ORDER BY reviewed_at DESC
         LIMIT 1
       ) r ON true
       WHERE f.next_due_at <= now() OR f.repetitions = 0
       ORDER BY f.next_due_at ASC, f.repetitions ASC
       LIMIT $1`,
      [limit],
    );

    return rows.map(r => ({
      id: r.id,
      question: r.question,
      topicLabel: r.topic_label,
      lastScore: r.last_score,
      daysOverdue: Math.max(
        0,
        Math.floor((Date.now() - new Date(r.next_due_at).getTime()) / (1000 * 60 * 60 * 24)),
      ),
    }));
  }

  async applyReview(id: number, score: string): Promise<Date> {
    const quality = SCORE_TO_QUALITY[score];
    if (quality === undefined) throw new Error(`Invalid score: ${score}`);

    const { rows } = await this.pool.query<{
      interval_days: number;
      ease_factor: number;
      repetitions: number;
    }>('SELECT interval_days, ease_factor, repetitions FROM flashcards WHERE id = $1', [id]);

    if (!rows[0]) throw new Error(`Flashcard ${id} not found`);

    const next = applySm2(
      { intervalDays: rows[0].interval_days, easeFactor: rows[0].ease_factor, repetitions: rows[0].repetitions },
      quality,
    );

    await this.pool.query(
      `UPDATE flashcards
       SET interval_days = $1, ease_factor = $2, repetitions = $3,
           next_due_at = $4, last_reviewed_at = now()
       WHERE id = $5`,
      [next.intervalDays, next.easeFactor, next.repetitions, next.nextDueAt, id],
    );

    await this.pool.query(
      'INSERT INTO flashcard_reviews (flashcard_id, score, sm2_quality) VALUES ($1, $2, $3)',
      [id, score, quality],
    );

    return next.nextDueAt;
  }

  async getById(id: number): Promise<FlashcardCard | null> {
    const { rows } = await this.pool.query<{
      id: number;
      question: string;
      answer: string;
      topic_label: string | null;
    }>('SELECT id, question, answer, topic_label FROM flashcards WHERE id = $1', [id]);

    if (!rows[0]) return null;
    return {
      id: rows[0].id,
      question: rows[0].question,
      answer: rows[0].answer,
      topicLabel: rows[0].topic_label,
    };
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx vitest run src/flashcard-service.test.ts
```

Expected: all 10 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/flashcard-service.ts src/flashcard-service.test.ts
git commit -m "feat: add FlashcardService with SM-2 scheduling"
```

---

## Task 3: FlashcardExtractor (TDD)

**Files:**
- Create: `src/flashcard-extractor.ts`
- Create: `src/flashcard-extractor.test.ts`

- [ ] **Step 1: Write failing tests — create `src/flashcard-extractor.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { FlashcardExtractor } from './flashcard-extractor';
import type pg from 'pg';
import type OpenAI from 'openai';

const fakeEmbedding = new Array(1536).fill(0.1);

function makePool(queryImpl: ReturnType<typeof vi.fn> = vi.fn()) {
  return { query: queryImpl } as unknown as pg.Pool;
}

function makeOpenAI(opts: { extractContent?: string; dupContent?: string } = {}) {
  return {
    chat: {
      completions: {
        create: vi.fn()
          .mockResolvedValueOnce({
            choices: [{ message: { content: opts.extractContent ?? '{"question":"What is Paris?","answer":"The capital of France."}' } }],
          })
          .mockResolvedValueOnce({
            choices: [{ message: { content: opts.dupContent ?? '{"isDuplicate":false}' } }],
          }),
      },
    },
    embeddings: {
      create: vi.fn().mockResolvedValue({ data: [{ embedding: fakeEmbedding }] }),
    },
  } as unknown as OpenAI;
}

describe('FlashcardExtractor', () => {
  describe('extract', () => {
    it('inserts a flashcard when a fact is extracted and no duplicate exists', async () => {
      const query = vi.fn()
        .mockResolvedValueOnce({ rows: [] })   // dedup: no near-matches
        .mockResolvedValueOnce({ rows: [] })   // mindmap_cache: empty
        .mockResolvedValueOnce({ rows: [] });  // INSERT
      const extractor = new FlashcardExtractor(makePool(query), makeOpenAI());

      await extractor.extract('What is the capital of France?', 'The capital of France is Paris.');

      const insertCall = query.mock.calls.find(c => String(c[0]).includes('INSERT INTO flashcards'));
      expect(insertCall).toBeDefined();
    });

    it('skips when LLM returns null extraction', async () => {
      const openai = makeOpenAI({ extractContent: '{"result":null}' });
      const query = vi.fn();
      const extractor = new FlashcardExtractor(makePool(query), openai);

      await extractor.extract('How are you?', 'Doing well!');

      expect(query).not.toHaveBeenCalled();
    });

    it('skips when duplicate is detected', async () => {
      const query = vi.fn()
        .mockResolvedValueOnce({ rows: [{ question: 'What is Paris?' }] }); // near-match
      const openai = makeOpenAI({ dupContent: '{"isDuplicate":true}' });
      const extractor = new FlashcardExtractor(makePool(query), openai);

      await extractor.extract('What is the capital of France?', 'Paris.');

      const insertCall = query.mock.calls.find(c => String(c[0]).includes('INSERT INTO flashcards'));
      expect(insertCall).toBeUndefined();
    });

    it('stamps topic_label when mindmap topics exist', async () => {
      const mindmapGraph = {
        nodes: [
          { type: 'topic', data: { label: 'Geography' } },
          { type: 'topic', data: { label: 'History' } },
        ],
      };
      const query = vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ graph: mindmapGraph }] })
        .mockResolvedValueOnce({ rows: [] });
      const extractor = new FlashcardExtractor(makePool(query), makeOpenAI());

      await extractor.extract('What is the capital of France?', 'Paris.');

      const insertCall = query.mock.calls.find(c => String(c[0]).includes('INSERT INTO flashcards'));
      expect(insertCall).toBeDefined();
    });
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run src/flashcard-extractor.test.ts
```

Expected: failures — "Cannot find module './flashcard-extractor'"

- [ ] **Step 3: Implement `src/flashcard-extractor.ts`**

```typescript
import OpenAI from 'openai';
import pg from 'pg';

interface ExtractedQA {
  question: string;
  answer: string;
}

function cosineDist(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export class FlashcardExtractor {
  constructor(
    private pool: pg.Pool,
    private openai: OpenAI,
  ) {}

  async extract(userMessage: string, assistantMessage: string): Promise<void> {
    if (!assistantMessage.trim()) return;

    const extracted = await this.extractQA(userMessage, assistantMessage);
    if (!extracted) return;

    const embRes = await this.openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: extracted.question,
    });
    const embedding = embRes.data[0]!.embedding;

    if (await this.isDuplicate(extracted.question, embedding)) return;

    const topicLabel = await this.findClosestTopic(embedding);

    await this.pool.query(
      `INSERT INTO flashcards (question, answer, topic_label, embedding)
       VALUES ($1, $2, $3, $4)`,
      [extracted.question, extracted.answer, topicLabel, JSON.stringify(embedding)],
    );
  }

  private async extractQA(userMessage: string, assistantMessage: string): Promise<ExtractedQA | null> {
    const res = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: `Given this conversation exchange, extract a single clear factual question and answer suitable for spaced repetition learning. If no clear fact was taught, respond with {"result":null}.\n\nUser: ${userMessage}\n\nAssistant: ${assistantMessage}\n\nReply as JSON: {"question": "...", "answer": "..."} or {"result": null}`,
      }],
    });

    const text = res.choices[0]?.message.content ?? '';
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (!parsed || parsed['result'] === null || !parsed['question'] || !parsed['answer']) return null;
      return { question: String(parsed['question']), answer: String(parsed['answer']) };
    } catch {
      return null;
    }
  }

  private async isDuplicate(question: string, embedding: number[]): Promise<boolean> {
    const { rows } = await this.pool.query<{ question: string }>(
      `SELECT question FROM flashcards WHERE embedding <=> $1 < 0.15 LIMIT 5`,
      [JSON.stringify(embedding)],
    );
    if (rows.length === 0) return false;

    const candidates = rows.map(r => r.question).join('\n- ');
    const res = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: `Is this new question asking about the same concept as any existing question?\n\nNew: ${question}\n\nExisting:\n- ${candidates}\n\nReply as JSON: {"isDuplicate": true} or {"isDuplicate": false}`,
      }],
    });

    try {
      const parsed = JSON.parse(res.choices[0]?.message.content ?? '{}') as Record<string, unknown>;
      return parsed['isDuplicate'] === true;
    } catch {
      return false;
    }
  }

  private async findClosestTopic(embedding: number[]): Promise<string | null> {
    const { rows } = await this.pool.query<{
      graph: { nodes: Array<{ type: string; data: { label: string } }> };
    }>('SELECT graph FROM mindmap_cache WHERE id = 1');

    if (!rows[0]) return null;

    const topicLabels = rows[0].graph.nodes
      .filter(n => n.type === 'topic')
      .map(n => n.data.label);
    if (topicLabels.length === 0) return null;

    const topicEmbeddings = await Promise.all(
      topicLabels.map(label =>
        this.openai.embeddings.create({ model: 'text-embedding-3-small', input: label })
          .then(r => ({ label, embedding: r.data[0]!.embedding })),
      ),
    );

    let closestLabel: string | null = null;
    let closestDist = Infinity;
    for (const { label, embedding: topicEmb } of topicEmbeddings) {
      const dist = cosineDist(embedding, topicEmb);
      if (dist < closestDist) { closestDist = dist; closestLabel = label; }
    }
    return closestLabel;
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx vitest run src/flashcard-extractor.test.ts
```

Expected: all 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/flashcard-extractor.ts src/flashcard-extractor.test.ts
git commit -m "feat: add FlashcardExtractor pipeline"
```

---

## Task 4: FlashcardSelectionAgent

**Files:**
- Create: `src/flashcard-agent.ts`

- [ ] **Step 1: Create `src/flashcard-agent.ts`**

```typescript
import pg from 'pg';
import { OpenAIAgent } from './openai-agent';
import { FunctionTool } from './tool';
import { FlashcardService } from './flashcard-service';

export const FLASHCARD_AGENT_INSTRUCTIONS = `You are a spaced repetition tutor. Select the single best flashcard for the user to review right now.

Call get_mindmap_topics to see what topics exist, then call get_due_flashcards to see available cards.

Prioritise in this order:
1. Cards with lastScore of "fail" or "hard" that are overdue (daysOverdue > 0)
2. Cards that have never been reviewed (lastScore is null)
3. Cards that are most overdue by daysOverdue

Prefer topic variety — if several cards are equally good candidates, pick from a less-recently-seen topic.

Respond with ONLY a JSON object: {"id": <number>} or {"id": null} if no cards are available. No other text.`;

export function createFlashcardSelectionAgent(pool: pg.Pool): OpenAIAgent {
  const service = new FlashcardService(pool);

  const getMindmapTopicsTool = new FunctionTool(
    async (_params) => {
      try {
        const { rows } = await pool.query<{
          graph: { nodes?: Array<{ type: string; data: { label: string } }> };
        }>('SELECT graph FROM mindmap_cache WHERE id = 1');
        if (!rows[0]) return JSON.stringify([]);
        const topics = (rows[0].graph.nodes ?? [])
          .filter(n => n.type === 'topic')
          .map(n => n.data.label);
        return JSON.stringify(topics);
      } catch {
        return JSON.stringify([]);
      }
    },
    'get_mindmap_topics',
    'Returns an array of topic label strings from the conversation mindmap. Returns [] if no mindmap exists yet.',
    { type: 'object', properties: {}, required: [] },
  );

  const getDueFlashcardsTool = new FunctionTool(
    async (_params) => {
      const cards = await service.getDueCards(10);
      return JSON.stringify(cards);
    },
    'get_due_flashcards',
    'Returns up to 10 flashcards due for review. Each card has: id (number), question (string), topicLabel (string|null), lastScore (string|null), daysOverdue (number).',
    { type: 'object', properties: {}, required: [] },
  );

  return new OpenAIAgent(
    'flashcard-selection-agent',
    FLASHCARD_AGENT_INSTRUCTIONS,
    { tools: [getMindmapTopicsTool, getDueFlashcardsTool] },
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/flashcard-agent.ts
git commit -m "feat: add FlashcardSelectionAgent"
```

---

## Task 5: Types + server endpoints + vite proxy

**Files:**
- Modify: `src/types.ts`
- Modify: `src/server.ts`
- Modify: `vite.config.ts`

- [ ] **Step 1: Update `AgentServerOptions` in `src/types.ts`**

Add this import at the very top of `src/types.ts` (before any interfaces):

```typescript
import type { FlashcardCard } from './flashcard-service';
```

Replace the existing `AgentServerOptions` interface (currently at the bottom of the file) with:

```typescript
export interface AgentServerOptions {
  staticDir?: string;
  getHistory?: (limit: number) => Promise<HistoryMessage[]>;
  getFlashcard?: () => Promise<FlashcardCard | null>;
  reviewFlashcard?: (id: number, score: string) => Promise<Date>;
}
```

- [ ] **Step 2: Add OPTIONS handlers and new routes to `src/server.ts`**

After the existing `app.options('/history', ...)` block, add:

```typescript
  app.options('/flashcard', (_req: Request, res: Response) => {
    res.sendStatus(204);
  });

  app.options('/flashcard/:id/review', (_req: Request, res: Response) => {
    res.sendStatus(204);
  });
```

After the existing `app.get('/history', ...)` block, add:

```typescript
  app.get('/flashcard', async (_req: Request, res: Response) => {
    if (!options.getFlashcard) {
      res.status(404).json({ error: 'Flashcard not configured' });
      return;
    }
    try {
      const card = await options.getFlashcard();
      res.json(card ?? null);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/flashcard/:id/review', async (req: Request, res: Response) => {
    if (!options.reviewFlashcard) {
      res.status(404).json({ error: 'Flashcard review not configured' });
      return;
    }
    const id = parseInt(String((req.params as Record<string, string>)['id']), 10);
    const score = (req.body as { score?: string }).score?.trim();
    if (!score || !['very_easy', 'easy', 'hard', 'fail'].includes(score)) {
      res.status(400).json({ error: 'score must be one of: very_easy, easy, hard, fail' });
      return;
    }
    try {
      const nextDueAt = await options.reviewFlashcard(id, score);
      res.json({ nextDueAt });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
```

- [ ] **Step 3: Add `/flashcard` to the Vite dev proxy in `vite.config.ts`**

Replace the `proxy` block with:

```typescript
    proxy: {
      '/chat':      'http://localhost:3000',
      '/history':   'http://localhost:3000',
      '/flashcard': 'http://localhost:3000',
    },
```

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/server.ts vite.config.ts
git commit -m "feat: add flashcard server endpoints and vite proxy"
```

---

## Task 6: Frontend hook

**Files:**
- Create: `src/ui/hooks/useFlashcard.ts`

- [ ] **Step 1: Create `src/ui/hooks/useFlashcard.ts`**

```typescript
import { useCallback, useEffect, useState } from 'react';

export type FlashcardPhase = 'idle' | 'question' | 'answer' | 'done';

export interface FlashcardData {
  id: number;
  question: string;
  answer: string;
  topicLabel: string | null;
}

export function useFlashcard() {
  const [card, setCard] = useState<FlashcardData | null>(null);
  const [phase, setPhase] = useState<FlashcardPhase>('idle');

  useEffect(() => {
    fetch('/flashcard')
      .then(r => (r.ok ? r.json() : null))
      .then((data: FlashcardData | null) => {
        if (data?.id) {
          setCard(data);
          setPhase('question');
        }
      })
      .catch(() => {});
  }, []);

  const reveal = useCallback(() => {
    setPhase('answer');
  }, []);

  const submitScore = useCallback(
    async (score: string) => {
      if (!card) return;
      await fetch(`/flashcard/${card.id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score }),
      }).catch(() => {});
      setPhase('done');
    },
    [card],
  );

  return { card, phase, reveal, submitScore };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/ui/hooks/useFlashcard.ts
git commit -m "feat: add useFlashcard hook"
```

---

## Task 7: FlashcardWidget component + App wiring

**Files:**
- Create: `src/ui/components/FlashcardWidget.tsx`
- Modify: `src/ui/App.tsx`

- [ ] **Step 1: Create `src/ui/components/FlashcardWidget.tsx`**

```typescript
import type { FlashcardData, FlashcardPhase } from '@/hooks/useFlashcard';

interface Props {
  card: FlashcardData;
  phase: FlashcardPhase;
  onReveal: () => void;
  onScore: (score: string) => void;
}

const SCORE_BUTTONS = [
  { score: 'fail',      label: 'Fail',      className: 'bg-red-500 hover:bg-red-600 text-white' },
  { score: 'hard',      label: 'Hard',      className: 'bg-amber-500 hover:bg-amber-600 text-white' },
  { score: 'easy',      label: 'Easy',      className: 'bg-green-500 hover:bg-green-600 text-white' },
  { score: 'very_easy', label: 'Very Easy', className: 'bg-teal-500 hover:bg-teal-600 text-white' },
] as const;

export function FlashcardWidget({ card, phase, onReveal, onScore }: Props) {
  if (phase === 'idle') return null;

  if (phase === 'done') {
    return (
      <div className="rounded-lg border border-border bg-muted/30 px-4 py-2 text-center text-sm text-muted-foreground">
        Review logged. See you next time!
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      {card.topicLabel && (
        <span className="mb-2 inline-block rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
          {card.topicLabel}
        </span>
      )}
      <p className="text-sm font-medium text-foreground">{card.question}</p>

      {phase === 'question' && (
        <button
          onClick={onReveal}
          className="mt-3 rounded-md bg-secondary px-4 py-1.5 text-sm font-medium text-secondary-foreground hover:bg-secondary/80"
        >
          Reveal Answer
        </button>
      )}

      {phase === 'answer' && (
        <>
          <hr className="my-3 border-border" />
          <p className="text-sm text-muted-foreground">{card.answer}</p>
          <div className="mt-3 flex gap-2">
            {SCORE_BUTTONS.map(({ score, label, className }) => (
              <button
                key={score}
                onClick={() => onScore(score)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium ${className}`}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Update `src/ui/App.tsx`**

Add two imports after the existing import lines:

```typescript
import { useFlashcard } from '@/hooks/useFlashcard';
import { FlashcardWidget } from '@/components/FlashcardWidget';
```

Add hook call inside `App`, after the `useChat` line:

```typescript
  const { card, phase, reveal, submitScore } = useFlashcard();
```

In the messages section, add the widget as the first child of the `flex flex-col gap-5` div, before `{messages.map(...)}`:

```tsx
          {card && (
            <FlashcardWidget card={card} phase={phase} onReveal={reveal} onScore={submitScore} />
          )}
          {messages.map(msg => (
            <Message key={msg.id} {...msg} />
          ))}
```

- [ ] **Step 3: Commit**

```bash
git add src/ui/components/FlashcardWidget.tsx src/ui/App.tsx
git commit -m "feat: add FlashcardWidget component"
```

---

## Task 8: Wire up api-server.ts

**Files:**
- Modify: `examples/api-server.ts`

- [ ] **Step 1: Add imports to `examples/api-server.ts`** (after the existing imports block)

```typescript
import { FlashcardService } from '../src/flashcard-service';
import { FlashcardExtractor } from '../src/flashcard-extractor';
import { createFlashcardSelectionAgent } from '../src/flashcard-agent';
import type { FlashcardCard } from '../src/flashcard-service';
```

- [ ] **Step 2: Add variable declarations before the `try` block**

In the `(async () => { ... })()` IIFE, find where `agentMemory` and `getHistory` are declared with `let`. Add immediately after them:

```typescript
  let getFlashcard: (() => Promise<FlashcardCard | null>) | undefined;
  let reviewFlashcard: ((id: number, score: string) => Promise<Date>) | undefined;
  let flashcardExtractor: FlashcardExtractor | undefined;
```

- [ ] **Step 3: Initialise services inside the postgres `try` block**

After the existing line `getHistory = (limit) => pgMemory.getHistory(limit);`, add:

```typescript
    const flashcardService = new FlashcardService(pool);
    const flashcardAgent = createFlashcardSelectionAgent(pool);
    flashcardExtractor = new FlashcardExtractor(pool, openaiClient);

    getFlashcard = async () => {
      const response = await flashcardAgent.run('Select a flashcard for review.');
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

    reviewFlashcard = (id: number, score: string) => flashcardService.applyReview(id, score);
```

- [ ] **Step 4: Replace the `createAgentServer` call with a version that wraps the stream factory**

Replace the entire `const app = createAgentServer(...)` block with:

```typescript
  const app = createAgentServer(
    async function* (message, signal) {
      let lastAssistantContent = '';
      for await (const item of createWeatherAgent().runStream(message, signal)) {
        const obj = item as Record<string, unknown>;
        if (obj['role'] === 'assistant' && typeof obj['content'] === 'string') {
          lastAssistantContent = obj['content'];
        }
        yield item;
      }
      if (flashcardExtractor) {
        flashcardExtractor.extract(message, lastAssistantContent).catch(console.error);
      }
    },
    {
      staticDir: path.join(__dirname, '../dist/ui'),
      getHistory,
      getFlashcard,
      reviewFlashcard,
    },
  );
```

- [ ] **Step 5: Commit**

```bash
git add examples/api-server.ts
git commit -m "feat: wire FlashcardExtractor and FlashcardSelectionAgent into api-server"
```

---

## Task 9: Eval — types + scenarios

**Files:**
- Create: `src/exercises/flashcard-eval/types.ts`
- Create: `src/exercises/flashcard-eval/scenarios.ts`

- [ ] **Step 1: Create `src/exercises/flashcard-eval/types.ts`**

```typescript
export interface DueCardMock {
  id: number;
  question: string;
  topicLabel: string | null;
  lastScore: string | null;
  daysOverdue: number;
}

export interface FlashcardScenario {
  id: string;
  description: string;
  mockMindmapTopics: string[];
  mockDueCards: DueCardMock[];
  expectedBehavior: string;
}

export interface JudgeScore {
  judgeName: string;
  score: number;         // 0–10
  justification: string;
}

export interface EvalResult {
  scenarioId: string;
  scenarioDescription: string;
  agentResponse: string;
  selectedCardId: number | null;
  judgeScores: JudgeScore[];
  averageScore: number;
}
```

- [ ] **Step 2: Create `src/exercises/flashcard-eval/scenarios.ts`**

```typescript
import type { FlashcardScenario } from './types';

export const scenarios: FlashcardScenario[] = [
  {
    id: 'overdue-fail',
    description: 'Single card, 14 days overdue, last score = fail',
    mockMindmapTopics: ['Weather', 'Geography'],
    mockDueCards: [
      { id: 1, question: 'What is the capital of France?', topicLabel: 'Geography', lastScore: 'fail', daysOverdue: 14 },
    ],
    expectedBehavior: 'Selects card id 1 — the only available card, which is overdue and previously failed.',
  },
  {
    id: 'topic-variety',
    description: '3 Geography cards + 1 History card, all equally due',
    mockMindmapTopics: ['Weather', 'Geography', 'History'],
    mockDueCards: [
      { id: 2, question: 'What is the capital of Germany?', topicLabel: 'Geography', lastScore: 'easy', daysOverdue: 0 },
      { id: 3, question: 'What is the capital of Spain?',   topicLabel: 'Geography', lastScore: 'easy', daysOverdue: 0 },
      { id: 4, question: 'What is the capital of Italy?',  topicLabel: 'Geography', lastScore: 'easy', daysOverdue: 0 },
      { id: 5, question: 'What year did WW2 end?',         topicLabel: 'History',   lastScore: 'easy', daysOverdue: 0 },
    ],
    expectedBehavior: 'Selects card id 5 (History topic) to introduce variety rather than a fourth Geography card.',
  },
  {
    id: 'no-cards',
    description: 'get_due_flashcards returns an empty array',
    mockMindmapTopics: ['Weather'],
    mockDueCards: [],
    expectedBehavior: 'Returns {"id": null} — no cards available, no hallucinated card id.',
  },
  {
    id: 'fail-vs-easy',
    description: 'Two equally overdue cards — one previously fail, one previously easy',
    mockMindmapTopics: ['Weather'],
    mockDueCards: [
      { id: 6, question: 'What causes thunder?',         topicLabel: 'Weather', lastScore: 'fail', daysOverdue: 3 },
      { id: 7, question: 'What is the Coriolis effect?', topicLabel: 'Weather', lastScore: 'easy', daysOverdue: 3 },
    ],
    expectedBehavior: 'Selects card id 6 (lastScore=fail) over card id 7 (lastScore=easy).',
  },
  {
    id: 'never-reviewed',
    description: 'One never-reviewed card available, no overdue cards',
    mockMindmapTopics: ['History'],
    mockDueCards: [
      { id: 8, question: 'Who was Napoleon Bonaparte?', topicLabel: 'History', lastScore: null, daysOverdue: 0 },
    ],
    expectedBehavior: 'Selects card id 8 — never-reviewed cards should be prioritised when nothing is overdue.',
  },
];
```

- [ ] **Step 3: Commit**

```bash
git add src/exercises/flashcard-eval/types.ts src/exercises/flashcard-eval/scenarios.ts
git commit -m "feat: add flashcard eval types and scenarios"
```

---

## Task 10: Eval — judges, report, entrypoint

**Files:**
- Create: `src/exercises/flashcard-eval/judges.ts`
- Create: `src/exercises/flashcard-eval/report.ts`
- Create: `src/exercises/flashcard-eval/index.ts`

- [ ] **Step 1: Create `src/exercises/flashcard-eval/judges.ts`**

```typescript
import { OpenAIChatClient } from '../../client';
import type { FlashcardScenario, JudgeScore } from './types';

abstract class LLMJudge {
  protected client = new OpenAIChatClient('gpt-4o-mini');
  abstract criteriaPrompt: string;

  get judgeName(): string { return this.constructor.name; }

  async judge(scenario: FlashcardScenario, agentResponse: string): Promise<JudgeScore> {
    const result = await this.client.create([
      {
        role: 'system',
        content: 'You are evaluating a spaced repetition card selection agent. Score 0–10. Respond with JSON only: {"score": number, "justification": string}',
        source: 'system',
        timestamp: new Date(),
      },
      {
        role: 'user',
        content: `${this.criteriaPrompt}\n\nScenario: ${scenario.description}\nExpected: ${scenario.expectedBehavior}\nAvailable cards: ${JSON.stringify(scenario.mockDueCards)}\nAgent response: ${agentResponse}`,
        source: 'user',
        timestamp: new Date(),
      },
    ]);

    try {
      const parsed = JSON.parse(result.message.content) as { score: number; justification: string };
      return { judgeName: this.judgeName, score: parsed.score, justification: parsed.justification };
    } catch {
      return { judgeName: this.judgeName, score: 0, justification: 'Failed to parse judge response' };
    }
  }
}

export class SelectionReasoningJudge extends LLMJudge {
  criteriaPrompt = 'Evaluate whether the agent clearly reasoned about WHY it selected the card it chose, citing relevant factors like daysOverdue, lastScore, or topic variety.';
}

export class PriorityJudge extends LLMJudge {
  criteriaPrompt = 'Evaluate whether the agent selected the correct card per SM-2 priority rules: fail/hard and overdue > never-reviewed > easy/very_easy; topic variety as tiebreaker. Score 0 if the wrong card was chosen when a clearly better card was available.';
}

export class EdgeCaseJudge extends LLMJudge {
  criteriaPrompt = 'Evaluate whether the agent handled the no-cards case by returning {"id": null} without hallucinating a card id. For scenarios with available cards, score 10 if a valid integer card id was returned.';
}
```

- [ ] **Step 2: Create `src/exercises/flashcard-eval/report.ts`**

```typescript
import type { EvalResult } from './types';

export function renderReport(results: EvalResult[]): string {
  const date = new Date().toISOString().split('T')[0]!;
  const judgeNames = results[0]?.judgeScores.map(j => j.judgeName) ?? [];

  const tableRows = results.map(r => `
    <tr>
      <td>${r.scenarioId}</td>
      <td>${r.scenarioDescription}</td>
      <td>${r.selectedCardId ?? 'null'}</td>
      <td><strong>${r.averageScore.toFixed(1)}</strong></td>
      ${r.judgeScores.map(j => `<td title="${j.justification.replace(/"/g, '&quot;')}">${j.score}</td>`).join('')}
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Flashcard Eval — ${date}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 960px; margin: 2rem auto; padding: 0 1rem; }
    h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
    canvas { max-height: 280px; margin-bottom: 2rem; }
    table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
    th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; }
    th { background: #f5f5f5; }
  </style>
</head>
<body>
  <h1>Flashcard Selection Eval — ${date}</h1>
  <p>${results.length} scenarios · ${judgeNames.length} judges</p>
  <h2>Average Score by Scenario</h2>
  <canvas id="chart1"></canvas>
  <h2>Score per Judge by Scenario</h2>
  <canvas id="chart2"></canvas>
  <h2>Detail (hover score cells for justification)</h2>
  <table>
    <thead><tr>
      <th>Scenario</th><th>Description</th><th>Selected ID</th><th>Avg</th>
      ${judgeNames.map(j => `<th>${j}</th>`).join('')}
    </tr></thead>
    <tbody>${tableRows}</tbody>
  </table>
  <script>
    const d = ${JSON.stringify({ results, judgeNames })};
    const colors = ['#3b82f6','#22c55e','#f97316','#a855f7','#06b6d4'];
    new Chart(document.getElementById('chart1'), {
      type: 'bar',
      data: {
        labels: d.results.map(r => r.scenarioId),
        datasets: [{ label: 'Avg Score', data: d.results.map(r => r.averageScore), backgroundColor: '#3b82f6' }],
      },
      options: { scales: { y: { min: 0, max: 10 } } },
    });
    new Chart(document.getElementById('chart2'), {
      type: 'bar',
      data: {
        labels: d.results.map(r => r.scenarioId),
        datasets: d.judgeNames.map((name, i) => ({
          label: name,
          data: d.results.map(r => r.judgeScores[i].score),
          backgroundColor: colors[i % colors.length],
        })),
      },
      options: { scales: { y: { min: 0, max: 10 } } },
    });
  </script>
</body>
</html>`;
}
```

- [ ] **Step 3: Create `src/exercises/flashcard-eval/index.ts`**

```typescript
import path from 'path';
import fs from 'fs';
import { config } from 'dotenv';
import { FunctionTool } from '../../tool';
import { OpenAIAgent } from '../../openai-agent';
import { FLASHCARD_AGENT_INSTRUCTIONS } from '../../flashcard-agent';
import { SelectionReasoningJudge, PriorityJudge, EdgeCaseJudge } from './judges';
import { scenarios } from './scenarios';
import { renderReport } from './report';
import type { EvalResult, FlashcardScenario } from './types';

config({ path: path.join(__dirname, '../../../.env') });

function createEvalAgent(scenario: FlashcardScenario): OpenAIAgent {
  const getMindmapTopicsTool = new FunctionTool(
    async (_params) => JSON.stringify(scenario.mockMindmapTopics),
    'get_mindmap_topics',
    'Returns an array of topic label strings from the conversation mindmap.',
    { type: 'object', properties: {}, required: [] },
  );

  const getDueFlashcardsTool = new FunctionTool(
    async (_params) => JSON.stringify(scenario.mockDueCards),
    'get_due_flashcards',
    'Returns up to 10 flashcards due for review.',
    { type: 'object', properties: {}, required: [] },
  );

  return new OpenAIAgent(
    'flashcard-selection-agent',
    FLASHCARD_AGENT_INSTRUCTIONS,
    { tools: [getMindmapTopicsTool, getDueFlashcardsTool] },
  );
}

function parseSelectedId(content: string): number | null {
  try {
    const parsed = JSON.parse(content) as { id?: number | null };
    return parsed.id ?? null;
  } catch {
    const match = content.match(/"id"\s*:\s*(\d+)/);
    return match ? parseInt(match[1]!, 10) : null;
  }
}

async function main() {
  const judges = [new SelectionReasoningJudge(), new PriorityJudge(), new EdgeCaseJudge()];
  const results: EvalResult[] = [];

  for (const scenario of scenarios) {
    console.log(`\nRunning scenario: ${scenario.id}`);
    const agent = createEvalAgent(scenario);
    const response = await agent.run('Select a flashcard for review.');
    const agentResponse = response.messages.at(-1)?.content ?? '';
    console.log(`  Agent: ${agentResponse}`);

    const judgeScores = [];
    for (const judge of judges) {
      const s = await judge.judge(scenario, agentResponse);
      console.log(`  ${s.judgeName}: ${s.score}/10`);
      judgeScores.push(s);
    }

    const averageScore = judgeScores.reduce((sum, j) => sum + j.score, 0) / judgeScores.length;
    results.push({
      scenarioId: scenario.id,
      scenarioDescription: scenario.description,
      agentResponse,
      selectedCardId: parseSelectedId(agentResponse),
      judgeScores,
      averageScore,
    });
  }

  const html = renderReport(results);
  const outPath = path.join(__dirname, 'report.html');
  fs.writeFileSync(outPath, html);
  console.log(`\nReport written to ${outPath}`);
}

main().catch(console.error);
```

- [ ] **Step 4: Run the eval end-to-end**

```bash
npx ts-node src/exercises/flashcard-eval/index.ts
```

Expected: console output for each of the 5 scenarios with agent response and 3 judge scores, followed by "Report written to src/exercises/flashcard-eval/report.html"

- [ ] **Step 5: Commit**

```bash
git add src/exercises/flashcard-eval/
git commit -m "feat: add flashcard eval exercise"
```

---

## Final verification

After all tasks are complete, run the full test suite:

```bash
npx vitest run
```

Expected: all tests pass including the new `flashcard-service.test.ts` and `flashcard-extractor.test.ts`
