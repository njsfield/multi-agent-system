# Topic Assignment Agent Design

**Date:** 2026-05-18
**Status:** Approved

## Problem

Flashcards are created without topic assignment. The existing `TopicDeterminationAgent` classifies messages but is never wired into the flashcard pipeline, so `flashcards.topic_id` is always null and the topics dropdown in the UI shows nothing.

The `subtopic` text field on `flashcards` is a weak approximation of hierarchy — it needs to be replaced by a proper parent/child topic tree that evolves as more cards accumulate.

## Goals

- Every new flashcard gets a `topic_id` assigned automatically after creation
- Topics are created dynamically by the LLM when no existing topic fits
- When a topic accumulates ≥6 cards and has no parent, it splits into 2 named child topics asynchronously
- The topic tree is hierarchical (max 2 levels: root → children)
- The UI topics dropdown reflects the live tree

## Non-Goals

- Backfilling existing unassigned flashcards (optional, out of scope)
- More than 2 levels of hierarchy
- Real-time split (async is sufficient)
- Embedding-based clustering (LLM-based is sufficient at current scale)

---

## Schema Changes

### `topics` — add `parent_id`

```sql
ALTER TABLE topics ADD COLUMN parent_id INTEGER REFERENCES topics(id) NULL;
```

- Root topics: `parent_id IS NULL`
- Child topics (after split): `parent_id = <original topic id>`
- Split guard: only topics with `parent_id IS NULL` and ≥6 cards are eligible to split

### `flashcards` — drop `subtopic`

```sql
ALTER TABLE flashcards DROP COLUMN subtopic;
```

Subtopic granularity is now expressed by assigning a child topic directly.

### Updated `TopicTree` type

```typescript
interface TopicTree {
  id: number;
  label: string;
  parentId: number | null;
  children: { id: number; label: string }[];
}
```

---

## TopicAssignmentAgent

New file: `src/topic-assignment-agent.ts`

Constructor takes `pg.Pool` and `OpenAI` client.

### `assignTopics(flashcardIds: number[]): Promise<void>`

1. Fetch question/answer for each flashcard ID
2. Fetch all existing topics (`id`, `label`, `parent_id`, card count)
3. Make a single LLM call with the cards and topic list
4. Parse JSON response — create any new topics, bulk-update `flashcards.topic_id`
5. For each affected topic, check: `count >= 6 AND parent_id IS NULL`
6. If true, fire `splitTopic(topicId)` as fire-and-forget

**LLM response shape:**
```json
{
  "assignments": [
    { "flashcardId": 1, "topicId": 3 },
    { "flashcardId": 2, "newTopicLabel": "Recursion" }
  ]
}
```

If LLM returns malformed JSON, retry once with a stricter prompt before giving up.
Deduplicate new topic labels within the same batch before inserting.

### `splitTopic(topicId: number): Promise<void>`

1. Inside a transaction, re-verify: `count >= 6 AND parent_id IS NULL` (idempotency guard)
2. Fetch all flashcard Q&As for the topic
3. LLM call: split into exactly 2 named groups
4. Create 2 new child topics with `parent_id = topicId`
5. Update `flashcards.topic_id` to the appropriate child topic
6. Commit

If LLM puts all cards in one group, log warning and abort (do not create empty child topics).

**LLM response shape:**
```json
{
  "group1": { "label": "Binary Trees", "flashcardIds": [1, 3, 5] },
  "group2": { "label": "Graph Traversal", "flashcardIds": [2, 4, 6] }
}
```

---

## Integration Points

### `FlashcardAgent.extract()`

After inserting flashcards, collect inserted IDs and call:
```typescript
topicAssignmentAgent.assignTopics(newIds).catch(console.error);
```
Fire-and-forget — does not block the chat response.

Remove: `sourceMessageId` lookup, `determineMessageTopic` fallback (both replaced by `TopicAssignmentAgent`).

### `FlashcardAgent.getTopicsWithSubtopics()`

Replace single JOIN query with:
1. `SELECT id, label, parent_id FROM topics ORDER BY label`
2. Assemble tree in TypeScript: root topics with `children` arrays

### `FlashcardAgent` constructor

Signature changes from `constructor(pool: pg.Pool)` to `constructor(pool: pg.Pool, openai: OpenAI)` so it can pass the client to `TopicAssignmentAgent`. The `openaiClient` already exists in `start-server.ts` and is passed through.

### `start-server.ts`

One change: `new FlashcardAgent(pool)` → `new FlashcardAgent(pool, openaiClient)`.

---

## Backfill Script

New file: `src/scripts/backfill-topics.ts`

A one-off CLI script that retroactively assigns topics to all existing flashcards with `topic_id = null`. Run with:

```bash
npx ts-node src/scripts/backfill-topics.ts
```

**Algorithm:**

1. Fetch all flashcards where `topic_id IS NULL`, ordered by `id ASC`
2. Process in batches of 20 (keeps LLM prompt size manageable)
3. For each batch, call `TopicAssignmentAgent.assignTopics(batchIds)` — same logic as the live pipeline, so new topics are created dynamically as needed
4. Log progress: `[backfill] batch N/M — assigned X cards, created Y new topics`
5. After all batches complete, check every topic for the split condition (≥6 cards, `parent_id IS NULL`) and run any pending splits sequentially (not fire-and-forget, so the script completes fully before exiting)
6. Print a summary: total cards assigned, topics created, topics split

**Idempotency:** Safe to run multiple times — only processes cards with `topic_id IS NULL`, so already-assigned cards are skipped.

**Error handling:** If a batch fails, log the error and continue with the next batch. Report failed batch IDs in the summary so they can be retried.

---

## Removals

| File / Symbol | Action |
|---|---|
| `src/topic-determination-agent.ts` | Delete entirely |
| `determineMessageTopic` import in `flashcard-agent.ts` | Remove |
| `flashcards.subtopic` column | Drop via migration |
| `subtopic` references in `types.ts`, `server.ts`, UI | Remove |

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| Assignment LLM returns malformed JSON | Retry once; log and skip on second failure |
| Split LLM returns malformed JSON | Log warning, abort split |
| Split LLM puts all cards in one group | Log warning, abort split |
| Two batches race to split same topic | Idempotency check inside transaction prevents double-split |
| New topic label collision within batch | Deduplicate before INSERT; assign both cards to single new topic |
| `assignTopics` throws | Logged via `.catch(console.error)`, cards left with `topic_id = null` |

---

## Data Flow Summary

```
User sends message
  → extract() saves flashcards (topic_id = null)
  → assignTopics(newIds) [async, fire-and-forget]
      → LLM assigns topics (creates new if needed)
      → if any topic hits ≥6 cards + no parent:
          → splitTopic(topicId) [async, fire-and-forget]
              → LLM splits into 2 groups
              → 2 child topics created, cards re-assigned
UI /topics endpoint
  → getTopicsWithSubtopics() returns tree: root topics + children

One-off backfill (manual)
  → npx ts-node src/scripts/backfill-topics.ts
  → processes all topic_id=null cards in batches of 20
  → runs any pending splits sequentially on completion
```
