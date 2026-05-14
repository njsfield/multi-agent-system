# Flashcard Topic Filter & On-Demand Fetch — Design Spec

**Date:** 2026-05-13  
**Status:** Approved

---

## Overview

Two related UI features:

1. **On-demand flashcard button** — a button to the right of the chat send button that fetches a due flashcard immediately (without requiring a page reload)
2. **Topic/subtopic filter dropdown** — a nested multiselect inline in the chat input bar that scopes which flashcards are eligible for review

---

## Data Model

### Schema change

Add `subtopic TEXT` to the `flashcards` table:

```sql
ALTER TABLE flashcards ADD COLUMN subtopic TEXT;

-- Backfill from source message
UPDATE flashcards f
SET subtopic = m.subtopic
FROM messages m
WHERE f.source_message_id = m.id;
```

### FlashcardFilter type

Shared type used by both backend and frontend:

```ts
interface FlashcardFilter {
  topicIds?: number[];
  subtopics?: Array<{ topicId: number; subtopic: string }>;
}
```

- `topicIds` — match any flashcard with one of these topic_ids (regardless of subtopic)
- `subtopics` — match flashcards with a specific (topicId, subtopic) pair
- Empty or omitted filter → no restriction, all due cards eligible

The two lists are OR-combined: a card matches if it satisfies any entry in either list.

---

## Backend

### FlashcardAgent — subtopic inheritance

When `extract()` creates a flashcard, look up the `subtopic` from the source message and store it on the flashcard row. No LLM call needed — it's a direct column copy.

### FlashcardAgent — `selectForReview(filter?)`

Updated signature:

```ts
selectForReview(filter?: FlashcardFilter): Promise<FlashcardCard | null>
```

SQL WHERE clause is built dynamically:

```sql
WHERE (next_due_at <= now() OR repetitions = 0)
  AND (
    topic_id IN (:topicIds)
    OR (topic_id = :t1 AND subtopic = :s1)
    OR (topic_id = :t2 AND subtopic = :s2)
    ...
  )
```

When filter is empty/undefined, the AND clause is omitted entirely.

### New endpoint: `GET /topics`

Returns the topic tree for the dropdown. Subtopics are derived from flashcards (not messages), so the dropdown only shows subtopics that actually have flashcards available:

```ts
GET /topics
→ Array<{ id: number; label: string; subtopics: string[] }>
```

Backed by a `getTopicsWithSubtopics()` method that queries:

```sql
SELECT t.id, t.label, array_agg(DISTINCT f.subtopic) FILTER (WHERE f.subtopic IS NOT NULL) AS subtopics
FROM topics t
JOIN flashcards f ON f.topic_id = t.id
GROUP BY t.id, t.label
ORDER BY t.label
```

Only topics that have at least one flashcard appear.

### Modified endpoint: `POST /flashcard`

New route alongside the existing `GET /flashcard`. The CORS OPTIONS handler in `server.ts` must cover this route too.

```
POST /flashcard
Content-Type: application/json
Body: { "topicIds": [1, 2], "subtopics": [{ "topicId": 1, "subtopic": "morning run" }] }
```

- Parses body as `FlashcardFilter`
- Calls `flashcardAgent.selectForReview(filter)`
- Returns same shape as `GET /flashcard`

`GET /flashcard` stays unchanged — used for the on-page-load fetch with no filter.

### `AgentServerOptions` additions

```ts
getTopics?: () => Promise<Array<{ id: number; label: string; subtopics: string[] }>>
```

---

## Frontend

### New type: `FlashcardFilter`

Defined in `src/ui/lib/types.ts` (new file), imported by hooks and components.

### `useTopics` hook (new)

```ts
// src/ui/hooks/useTopics.ts
function useTopics(): { topics: TopicTree[]; loading: boolean }
```

Fetches `GET /topics` once on mount. Returns the nested tree for the dropdown.

### `useFlashcard` changes

Add `fetchNext(filter?: FlashcardFilter)`:

```ts
const fetchNext = useCallback(async (filter?: FlashcardFilter) => {
  const res = await fetch('/flashcard', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(filter ?? {}),
  });
  const data = await res.json();
  if (data?.id) { setCard(data); setPhase('question'); }
}, []);
```

Existing on-mount `GET /flashcard` stays — it runs with no filter on page load.

### `App` — filter state

Filter selection lives in `App`:

```ts
const [flashcardFilter, setFlashcardFilter] = useState<FlashcardFilter>({});
```

Passed down to `ChatInput` as props. `fetchNext` from `useFlashcard` is also passed down.

### `ChatInput` changes

Three new props:

```ts
topics: TopicTree[]
onFetchFlashcard: (filter: FlashcardFilter) => void
isFlashcardActive: boolean   // true when phase is 'question' or 'answer'
```

Layout:

```
[ text input ][ TopicFilterDropdown ][ FlashcardButton ][ Send/Stop ]
```

`TopicFilterDropdown` owns its open/close state internally. On selection change it calls a callback that updates `flashcardFilter` in `App`. `FlashcardButton` is disabled when `phase === 'question' || phase === 'answer'` (a card is already active).

### `TopicFilterDropdown` component (new)

Custom popover, no external library. Toggle button with a badge showing count of selected items when non-zero. Panel is positioned above the input bar (`bottom: 100%`), renders a scrollable two-level tree:

```
☐ Cardio Training
    ☐ morning run
    ☐ cardiovascular endurance
☐ Investing
    ☐ asset allocation
    ☐ long-term portfolio
...
```

Behaviours:
- Topics and subtopics independently selectable — no auto-cascade
- Clicking outside the panel closes it
- "Clear all" link when any items are selected
- Selection state managed in `App` via callback; dropdown receives it as props

### `FlashcardButton` component (new)

`BookOpen` icon from lucide-react. Calls `onFetchFlashcard(filter)` on click. Disabled when a card is already in `question` or `answer` phase.

---

---

## Multi-flashcard extraction

### Behaviour change

`extract()` currently produces at most 1 flashcard per exchange. It will be updated to extract **up to 5 distinct facts** per exchange.

The prompt instructs the LLM to:
- Identify all distinct, independently learnable facts in the exchange
- Emit only facts that are not duplicates of each other within the batch
- Return a JSON array of up to 5 `{ question, answer }` pairs
- Return an empty array if no learnable facts exist

Each candidate is then independently checked against the existing flashcard DB using the existing cosine-similarity deduplication logic. Cards that pass deduplication are inserted, others are silently skipped.

Topic and subtopic are inherited from the source message for all cards in the batch — same `topic_id` and `subtopic` for every card extracted from the same exchange.

### Prompt response shape

```json
{
  "flashcards": [
    { "question": "...", "answer": "..." },
    { "question": "...", "answer": "..." }
  ]
}
```

Max 5 entries. Empty array `[]` when nothing learnable is found.

---

## Extraction eval (`flashcard-agent.eval.ts` addition)

A new eval section added to the existing `flashcard-agent.eval.ts`, following the same pattern as the selection eval (mock tools, `runEval`, LLM judges).

### Mock tool

A `save_flashcards` mock tool replaces the real DB insert. It accepts an array of `{ question, answer }` objects and records them in local state for the judge to inspect.

### Scenarios

| id | Exchange description | Expected |
|---|---|---|
| `multi-fact-rich` | A detailed explanation of how compound interest works, covering: what it is, the formula, the rule of 72, the effect of frequency, and comparison to simple interest | ≥ 3 distinct flashcards extracted |
| `single-fact-simple` | User asks what the capital of France is, assistant says Paris | Exactly 1 flashcard |
| `no-facts` | User says "thanks, that's helpful" and assistant says "you're welcome" | 0 flashcards |
| `near-duplicate-facts` | Exchange that repeats the same fact in two different phrasings | Exactly 1 flashcard (prompt-level deduplication within batch) |
| `max-cap` | An extremely detailed exchange touching 10+ distinct facts | At most 5 flashcards |

### Judges

- **CountJudge** — checks count is within expected bounds for the scenario
- **DistinctnessJudge** — checks that extracted cards are genuinely distinct from each other (no rephrasing of the same concept)
- **QualityJudge** — checks that questions are clear, specific, and answerable; answers are accurate and concise

### File

New eval added inline to `src/flashcard-agent.eval.ts` as a second `runEval` call with `agentName: 'FlashcardAgent:extraction'`.

---

## Updated file map

| File | Change |
|---|---|
| `schema.sql` | Add `subtopic` column to `flashcards` |
| `src/flashcard-agent.ts` | `selectForReview(filter?)`, `extract()` extracts up to 5 cards, `getTopicsWithSubtopics()` |
| `src/server.ts` | Add `GET /topics`, `POST /flashcard` routes; extend `AgentServerOptions` |
| `src/start-server.ts` | Wire `getTopics` into server options |
| `src/ui/lib/types.ts` | New — `FlashcardFilter`, `TopicTree` types |
| `src/ui/hooks/useTopics.ts` | New — fetches topic tree |
| `src/ui/hooks/useFlashcard.ts` | Add `fetchNext(filter?)` |
| `src/ui/components/TopicFilterDropdown.tsx` | New — nested multiselect popover |
| `src/ui/components/FlashcardButton.tsx` | New — icon button |
| `src/ui/components/ChatInput.tsx` | Add dropdown + flashcard button |
| `src/ui/App.tsx` | Add filter state, wire new props |
| `src/flashcard-agent.eval.ts` | Add extraction eval scenarios and judges |

---

## Out of scope

- Persisting filter selection across page reloads
- Showing subtopic badges on the flashcard widget
- Filtering the chat history or mindmap by topic
