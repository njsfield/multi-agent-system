# Design: Flashcard Spaced Repetition

**Date:** 2026-05-03  
**Status:** Approved

---

## Overview

On every page load, a flashcard drawn from previous conversation history appears inline at the top of the chat message list. The question is sourced from a curated library of Q&A pairs extracted from past agent responses. The user reveals the answer and scores their recall (Very Easy / Easy / Hard / Fail). Scheduling follows the SM-2 spaced repetition algorithm. A `FlashcardSelectionAgent` picks the best card at session start using mindmap topic awareness.

**Pre-requisites:** The mindmap feature (`feature/mindmap`) must be merged first — this design depends on the `mindmap_cache` table and topic labels it provides.

---

## Section 1: Data Layer

Two new tables appended to `schema.sql`:

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

SM-2 quality mapping: `fail=0`, `hard=2`, `easy=4`, `very_easy=5`.

SM-2 state (`interval_days`, `ease_factor`, `repetitions`, `next_due_at`) lives directly on `flashcards` and is mutated after each review. `flashcard_reviews` is append-only history used by the agent and eval to look up last score.

---

## Section 2: Extraction Pipeline — `src/flashcard-extractor.ts`

`FlashcardExtractor` class. Instantiated once in `examples/api-server.ts` alongside `PgVectorMemory`. Triggered fire-and-forget after each agent response:

```typescript
async function* (message, signal) {
  yield* agent.runStream(message, signal);
  extractor.extract(message, lastAssistantContent).catch(console.error);
}
```

**Pipeline inside `extract(userMessage, assistantMessage)`:**

1. **LLM extraction** — `gpt-4o-mini` call:
   > "Given this exchange, extract a single clear factual question and answer suitable for spaced repetition. If no clear fact was taught, respond with `null`. Reply as JSON: `{\"question\": \"...\", \"answer\": \"...\"}` or `null`."

2. If `null` returned — stop.

3. **Embed** — `text-embedding-3-small` on the extracted question text.

4. **Dedup check** — query `flashcards` for embeddings within cosine distance `0.15` (similarity > 0.85). If matches exist, a second LLM judge call determines whether it's the same concept. Skip if duplicate.

5. **Topic stamp** — cosine-match the question embedding against mindmap topic label embeddings from `mindmap_cache`. Assign the closest topic label. If no mindmap exists yet, `topic_label = null`.

6. **Insert** into `flashcards` with default SM-2 state.

All errors are caught and logged; `extract()` never throws to the caller.

---

## Section 3: Session-Start Agent & Server Endpoints

### `src/flashcard-agent.ts` — `FlashcardSelectionAgent`

Extends `Agent`. Two tools:

**`get_mindmap_topics()`**
Reads `mindmap_cache`, returns array of topic label strings. Returns `[]` if no mindmap exists.

**`get_due_flashcards()`**
Queries `flashcards` where `next_due_at <= now()` OR `repetitions = 0` (never reviewed), left-joined with the most recent `flashcard_reviews` row. Returns top 10 sorted by `next_due_at ASC, repetitions ASC`. Each result includes: `id`, `question`, `topic_label`, `last_score`, `days_overdue`.

Agent instructions:
> "Select the single best flashcard for the user to review right now. Prioritise cards that are most overdue and have a previous score of 'fail' or 'hard'. Prefer topic variety — avoid the same topic shown in the last session if alternatives exist. Return only the flashcard `id`."

### `src/flashcard-service.ts` — `FlashcardService`

Handles all DB operations:
- `getDueCards(limit: number)` — the query above
- `applyReview(id: number, score: string)` — computes SM-2, updates `flashcards` (including `last_reviewed_at = now()`), inserts `flashcard_reviews` row
- `getById(id: number)` — fetches full card for the reveal endpoint

**SM-2 formula** (pure function `applySm2(state, quality) → newState`):
```
if quality < 3:
  repetitions = 0
  interval_days = 1
else:
  if repetitions == 0: interval_days = 1
  elif repetitions == 1: interval_days = 6
  else: interval_days = round(interval_days × ease_factor)
  repetitions++

ease_factor += 0.1 - (5 - quality) × (0.08 + (5 - quality) × 0.02)
ease_factor = max(1.3, ease_factor)
next_due_at = now + interval_days
```

### Server endpoints

`AgentServerOptions` gains two optional fields: `getFlashcard` and `reviewFlashcard`.

```
GET  /flashcard              → runs FlashcardSelectionAgent
                               returns { id, question, topic_label } | null

POST /flashcard/:id/review   body: { score: 'very_easy' | 'easy' | 'hard' | 'fail' }
                               applies SM-2, returns { next_due_at }
```

Both follow the same guard pattern as `/history` — return 404 if not configured.

`vite.config.ts` proxy gains `/flashcard` entry.

---

## Section 4: Frontend

### `src/ui/hooks/useFlashcard.ts`

```typescript
type FlashcardPhase = 'idle' | 'question' | 'answer' | 'done';

export function useFlashcard() {
  const [card, setCard] = useState<{ id: number; question: string; topic_label: string | null } | null>(null);
  const [phase, setPhase] = useState<FlashcardPhase>('idle');

  useEffect(() => {
    fetch('/flashcard')
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) { setCard(data); setPhase('question'); } })
      .catch(() => {});
  }, []);

  const reveal = () => setPhase('answer');

  const submitScore = async (score: string) => {
    if (!card) return;
    await fetch(`/flashcard/${card.id}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ score }),
    });
    setPhase('done');
  };

  return { card, phase, reveal, submitScore };
}
```

### `src/ui/components/FlashcardWidget.tsx`

Props: `{ card, phase, onReveal, onScore }`.

- **Question phase:** topic badge + question text + "Reveal Answer" button
- **Answer phase:** question + divider + answer text + four score buttons left-to-right: `Fail` (red) · `Hard` (amber) · `Easy` (green) · `Very Easy` (teal)
- **Done phase:** collapses to a single line — *"Review logged. See you next time!"*

### `App.tsx` change

```typescript
const { card, phase, reveal, submitScore } = useFlashcard();
// above messages.map(...)
{card && <FlashcardWidget card={card} phase={phase} onReveal={reveal} onScore={submitScore} />}
```

---

## Section 5: Eval — `src/exercises/flashcard-eval/`

Mirrors the `music-eval` structure. Tests `FlashcardSelectionAgent` selection quality across canned scenarios with mock tool responses.

**File structure:**
```
src/exercises/flashcard-eval/
  index.ts      # entrypoint: runs all scenarios, writes report.html
  types.ts      # FlashcardScenario, JudgeScore, EvalResult
  scenarios.ts  # canned scenarios with mock tool responses
  judges.ts     # LLM judges
  report.ts     # renderReport() → self-contained HTML
```

**Scenarios:**

| ID | Setup | Expected behaviour |
|---|---|---|
| `overdue-fail` | One card, 14 days overdue, last score = fail | Selects it |
| `topic-variety` | 3 cards same topic + 1 different topic, all equally due | Selects the different-topic card |
| `no-cards` | `get_due_flashcards()` returns `[]` | Returns null gracefully |
| `fail-vs-easy` | Two equally overdue cards — one previously fail, one easy | Selects the fail card |
| `never-reviewed` | Mix of reviewed and never-reviewed, nothing overdue | Prefers never-reviewed |

**Judges** (extend `LLMJudge` same as music-eval):

| Class | Focus |
|---|---|
| `SelectionReasoningJudge` | Did the agent reason clearly about why it chose this card? |
| `PriorityJudge` | Did it correctly prioritise overdue/fail cards? |
| `EdgeCaseJudge` | Did it handle the no-cards scenario without hallucinating a card? |

**Entrypoint flow:** run each scenario through the agent with mocked tools → score with all judges → write HTML report (Chart.js from CDN, same pattern as music-eval).

---

## Dependencies

No new npm packages required — `pgvector`, `openai`, React, and Express are already present.

---

## Schema Migration

Append to `schema.sql` and run against the local database:

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
