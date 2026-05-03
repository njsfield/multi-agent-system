# Design: Conversation Mindmap

**Date:** 2026-05-03
**Status:** Approved

---

## Overview

A "View Mindmap" button in the chat header opens a full-page interactive spider diagram showing the high-level topics that have been discussed and the key facts associated with each. Topics are derived by clustering the pgvector message embeddings already stored in postgres. The graph is pre-computed incrementally after each conversation turn and rendered with React Flow.

---

## User Experience

- **Entry point:** "🗺 Mindmap" button in the chat header
- **View:** Full-page (replaces chat entirely); "← Back" button returns to chat
- **Content:** Central "All Topics" hub → topic nodes (colour-coded) → fact chips (dashed lines)
- **Interaction:** Zoom, pan, drag nodes — all provided by React Flow out of the box
- **Empty state:** If fewer than 6 messages exist, the page shows "Not enough conversation history yet"
- **Stale state:** Graph shown is whatever was last computed; a subtle "Updated X ago" timestamp in the corner

---

## Section 1: Data Layer

### New postgres table

```sql
CREATE TABLE mindmap_cache (
  id         INT PRIMARY KEY DEFAULT 1,
  graph      JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

Single row, upserted in place after each turn. The `graph` JSONB shape:

```typescript
interface MindmapGraph {
  nodes: MindmapNode[];
  edges: MindmapEdge[];
  updatedAt?: string;  // ISO timestamp from mindmap_cache.updated_at
}
interface MindmapNode {
  id: string;
  type: 'center' | 'topic' | 'fact';
  data: { label: string; color?: string };
}
interface MindmapEdge {
  id: string;
  source: string;
  target: string;
}
```

Example graph payload:
```json
{
  "nodes": [
    { "id": "center", "type": "center", "data": { "label": "All Topics" } },
    { "id": "topic-0", "type": "topic", "data": { "label": "Weather", "color": "#3b82f6" } },
    { "id": "fact-0-0", "type": "fact", "data": { "label": "Asked about Paris 3×" } },
    { "id": "fact-0-1", "type": "fact", "data": { "label": "Prefers Celsius" } }
  ],
  "edges": [
    { "id": "e-center-0", "source": "center", "target": "topic-0" },
    { "id": "e-0-fact-0-0", "source": "topic-0", "target": "fact-0-0" },
    { "id": "e-0-fact-0-1", "source": "topic-0", "target": "fact-0-1" }
  ]
}
```

### Shared types (`src/types.ts`)

Add `MindmapNode`, `MindmapEdge`, and `MindmapGraph` interfaces as above.

---

## Section 2: Clustering Pipeline — `src/mindmap.ts`

**New file: `src/mindmap.ts`** — exports `MindmapService` class.

Constructor: `(pool: pg.Pool, openai: OpenAI)`

Public methods:
- `recompute(): Promise<void>` — runs the clustering pipeline and upserts the result; guarded by an `isRecomputing` boolean so concurrent calls (two messages arriving quickly) skip rather than overlap
- `getGraph(): Promise<MindmapGraph>` — reads the current `mindmap_cache` row; returns `{ nodes: [], edges: [] }` if no row exists yet

### Pipeline inside `recompute()`

1. **Fetch embeddings** — `SELECT me.id, me.content, me.embedding FROM message_embeddings me JOIN messages m ON m.id = me.message_id ORDER BY m.id ASC`
2. **Guard** — if fewer than 6 rows, upsert `{ nodes: [], edges: [] }` and return
3. **Adaptive k** — `k = Math.min(Math.ceil(count / 5), 8)`
4. **k-means** — run `ml-kmeans` on the embedding vectors (parsed from JSON strings)
5. **Cluster representatives** — for each cluster, find the 3 messages closest to the centroid (lowest cosine distance)
6. **LLM labelling** — one `gpt-4o-mini` call per cluster:
   > "These are excerpts from a conversation. Name the topic in 2-4 words, then list up to 3 facts (each under 8 words). Reply as JSON: `{\"topic\": \"...\", \"facts\": [\"...\"]}`"
7. **Build graph** — construct nodes and edges with positions omitted (positions computed client-side)
8. **Upsert** — `INSERT INTO mindmap_cache (id, graph) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET graph = EXCLUDED.graph, updated_at = now()`

### Topic colours

Fixed palette of 8 colours cycled by cluster index:
```typescript
const TOPIC_COLORS = ['#3b82f6','#22c55e','#f97316','#a855f7','#06b6d4','#eab308','#ec4899','#14b8a6'];
```

### Error handling

- If `ml-kmeans` throws (e.g. k > number of points), catch and upsert empty graph
- If an LLM call fails for a cluster, use the first representative message content as the label and skip facts for that cluster
- All errors logged; `recompute()` never throws to the caller

---

## Section 3: API Endpoint

### `src/types.ts`

Add `MindmapGraph`, `MindmapNode`, `MindmapEdge` interfaces.

### `src/server.ts`

Extend `AgentServerOptions`:
```typescript
export interface AgentServerOptions {
  staticDir?: string;
  getHistory?: (limit: number) => Promise<HistoryMessage[]>;
  getMindmap?: () => Promise<MindmapGraph>;
}
```

Add route (same pattern as `/history`):
```typescript
app.get('/mindmap', async (_req, res) => {
  if (!options.getMindmap) { res.status(404).json({ error: 'Mindmap not configured' }); return; }
  try {
    res.json(await options.getMindmap());
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
```

Add `OPTIONS /mindmap` preflight handler.

### `examples/api-server.ts`

- Create `MindmapService` instance alongside `PgVectorMemory` (same `pool` + `openai` instances)
- Pass `getMindmap: () => mindmapService.getGraph()` to `createAgentServer`
- Wrap the stream factory to trigger `recompute()` fire-and-forget after each turn:

```typescript
async function* (message, signal) {
  yield* createWeatherAgent().runStream(message, signal);
  mindmapService.recompute().catch(console.error);
}
```

`getGraph()` is defined on `MindmapService` (see Section 2).

### `vite.config.ts`

Add `/mindmap` to the dev proxy:
```typescript
proxy: {
  '/chat':    'http://localhost:3000',
  '/history': 'http://localhost:3000',
  '/mindmap': 'http://localhost:3000',
},
```

---

## Section 4: Frontend

### `src/ui/App.tsx`

Add `view` state:
```typescript
const [view, setView] = useState<'chat' | 'mindmap'>('chat');
```

Header gets a "🗺 Mindmap" button. When `view === 'mindmap'`, the full-page `<Mindmap />` component is rendered instead of the message list and input. The header in mindmap view shows a "← Back" button and hides the mindmap button.

### `src/ui/hooks/useMindmap.ts`

```typescript
export function useMindmap() {
  const [graph, setGraph]   = useState<MindmapGraph>({ nodes: [], edges: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState<string | null>(null);

  useEffect(() => {
    fetch('/mindmap')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(setGraph)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return { graph, loading, error };
}
```

### `src/ui/components/Mindmap.tsx`

Uses `ReactFlow` with three custom node types: `CenterNode`, `TopicNode`, `FactNode`.

**Node positions** computed mathematically before passing to React Flow:
- Center node: `{ x: 0, y: 0 }`
- Topic nodes: equally spaced on a circle of radius 280px around center
- Fact nodes: fanned in a short arc at radius 180px beyond their topic node

**Edge styles:**
- Center → topic: solid, 2px, topic colour
- Topic → fact: dashed, 1px, grey

**Empty state:** if `graph.nodes.length === 0`, render a centered message: *"Not enough conversation history yet — keep chatting!"*

**`updated_at` timestamp:** `MindmapGraph` includes an optional `updatedAt: string` field; displayed as *"Updated X ago"* in the bottom-right corner using a simple relative-time formatter.

### New dependency

```bash
yarn add reactflow
```

---

## Dependencies to Add

| Package | Purpose |
|---------|---------|
| `reactflow` | Interactive graph UI component |
| `ml-kmeans` | k-means clustering of embedding vectors (ships its own TypeScript types) |

---

## Schema Migration

Append to `schema.sql` and run against the local database:
```sql
CREATE TABLE mindmap_cache (
  id         INT PRIMARY KEY DEFAULT 1,
  graph      JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

---

## Seed Data

**New file: `seed.sql`**

Seeds 15 messages (5 per topic: weather, health, finance) into the `messages` table and inserts a hand-crafted `mindmap_cache` row so the mindmap view works immediately without needing real embeddings or a prior conversation.

`message_embeddings` is intentionally left empty in the seed — real embeddings accumulate as the app is used and the clustering pipeline overwrites the seeded graph on the first real conversation turn.

Run after schema migration:
```bash
psql $DATABASE_URL -f seed.sql
```

### Messages (15 rows across 3 topics)

```sql
INSERT INTO messages (role, content, source) VALUES
  -- Weather
  ('user',      'What is the weather like in London today?',                      'user'),
  ('assistant', 'London is currently 14°C with light rain and overcast skies.',   'weather-agent'),
  ('user',      'Will it be sunny in Paris this weekend?',                        'user'),
  ('assistant', 'Paris looks clear on Saturday, 22°C, with clouds Sunday.',       'weather-agent'),
  ('user',      'What is the UV index in Tokyo tomorrow?',                        'user'),

  -- Health
  ('user',      'How much water should I drink each day?',                        'user'),
  ('assistant', 'Most adults need around 2 litres of water per day.',             'weather-agent'),
  ('user',      'What are the benefits of walking 10,000 steps a day?',           'user'),
  ('assistant', 'Daily walking improves cardiovascular health and mood.',         'weather-agent'),
  ('user',      'How many hours of sleep does an adult need?',                    'user'),

  -- Finance
  ('user',      'What is a good way to start saving money?',                      'user'),
  ('assistant', 'Start with a monthly budget and automate a savings transfer.',   'weather-agent'),
  ('user',      'Should I invest in index funds or individual stocks?',           'user'),
  ('assistant', 'Index funds offer diversification and lower risk for beginners.','weather-agent'),
  ('user',      'What is compound interest and why does it matter?',              'user');
```

### Seeded mindmap_cache (hand-crafted graph)

```sql
INSERT INTO mindmap_cache (id, graph) VALUES (1, '{
  "nodes": [
    {"id":"center",    "type":"center", "data":{"label":"All Topics"}},
    {"id":"topic-0",   "type":"topic",  "data":{"label":"Weather",  "color":"#3b82f6"}},
    {"id":"topic-1",   "type":"topic",  "data":{"label":"Health",   "color":"#22c55e"}},
    {"id":"topic-2",   "type":"topic",  "data":{"label":"Finance",  "color":"#f97316"}},
    {"id":"fact-0-0",  "type":"fact",   "data":{"label":"Asked about London, Paris, Tokyo"}},
    {"id":"fact-0-1",  "type":"fact",   "data":{"label":"Interested in UV index"}},
    {"id":"fact-1-0",  "type":"fact",   "data":{"label":"Curious about daily habits"}},
    {"id":"fact-1-1",  "type":"fact",   "data":{"label":"Sleep and hydration questions"}},
    {"id":"fact-2-0",  "type":"fact",   "data":{"label":"Saving and budgeting focus"}},
    {"id":"fact-2-1",  "type":"fact",   "data":{"label":"Asked about index funds"}}
  ],
  "edges": [
    {"id":"e-c-0",     "source":"center",  "target":"topic-0"},
    {"id":"e-c-1",     "source":"center",  "target":"topic-1"},
    {"id":"e-c-2",     "source":"center",  "target":"topic-2"},
    {"id":"e-0-f0",    "source":"topic-0", "target":"fact-0-0"},
    {"id":"e-0-f1",    "source":"topic-0", "target":"fact-0-1"},
    {"id":"e-1-f0",    "source":"topic-1", "target":"fact-1-0"},
    {"id":"e-1-f1",    "source":"topic-1", "target":"fact-1-1"},
    {"id":"e-2-f0",    "source":"topic-2", "target":"fact-2-0"},
    {"id":"e-2-f1",    "source":"topic-2", "target":"fact-2-1"}
  ],
  "updatedAt": "2026-05-03T00:00:00Z"
}')
ON CONFLICT (id) DO NOTHING;
```
