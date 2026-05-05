# System Architecture

Detailed architectural documentation for the TS-Agent system.

## High-Level System Architecture

```mermaid
graph TB
    subgraph Frontend["Frontend Layer (React)"]
        UI["Chat UI + Flashcard Widget + Mindmap"]
        useChat["useChat Hook"]
        UI -->|useState, useEffect| useChat
    end

    subgraph API["API Layer (Express)"]
        Router["Route Handlers"]
        SSE["SSE Streaming"]
        Router -->|text/event-stream| SSE
    end

    subgraph Agent["Agent Layer (OpenAI)"]
        OAI["OpenAI Agent"]
        Tools["Function Tools<br/>fetch_weather, etc"]
        Memory["Conversation Memory"]
        OAI -->|calls| Tools
        OAI -->|reads/writes| Memory
    end

    subgraph Services["Service Layer"]
        Topics["Topic Determiner<br/>(New)"]
        Extract["Flashcard Extractor"]
        Mindmap["Mindmap Service"]
        FC["Flashcard Service<br/>SM-2 Algorithm"]
    end

    subgraph Storage["Data Layer"]
        PG["PostgreSQL"]
        Embeddings["Vector Index<br/>pgvector"]
        PG -->|stores embeddings| Embeddings
    end

    Frontend -->|POST /chat| Router
    Router -->|streamFactory| Agent
    Agent -->|yield| SSE
    SSE -->|event-stream| Frontend
    
    Agent -->|background| Topics
    Agent -->|background| Extract
    Agent -->|background| Mindmap
    
    Topics -->|read/write| PG
    Extract -->|read/write| PG
    Mindmap -->|read/write| PG
    FC -->|read/write| PG
    
    PG -->|openai.embeddings| OpenAI["OpenAI API"]
    Memory -->|openai.embeddings| OpenAI
```

## Runtime Flow: Detailed Sequence

```mermaid
sequenceDiagram
    actor User
    participant Frontend
    participant API
    participant Agent
    participant OpenAI
    participant Services
    participant Database

    User->>Frontend: Types message & hits send
    Frontend->>API: POST /chat with message
    API->>API: Validate & log request
    
    alt Message Processing Pipeline
        API->>Agent: streamFactory(message)
        
        par Agent Processing
            Agent->>OpenAI: chat.completions.create()
            OpenAI->>Agent: Stream tokens
            Agent->>API: Yield tokens
            API->>Frontend: SSE event (token)
            Frontend->>User: Display token
        and Background Tasks (fire-and-forget)
            Agent->>Services: flashcardExtractor.extract()
            Services->>OpenAI: extract Q&A from last response
            Services->>Database: INSERT flashcard
            
            Agent->>Services: mindmapService.recompute()
            Services->>Database: Query all messages by topic
            Services->>OpenAI: label clusters
            Services->>Database: UPDATE mindmap_cache
            
            Agent->>Services: topicDeterminer.determine()
            Services->>OpenAI: classify message topic
            Services->>Database: UPDATE message with topic_id
        end
        
        Agent->>API: Return when done
    end
    
    API->>Frontend: Send done event
    Frontend->>Database: GET /history (async)
    Frontend->>Database: GET /mindmap (async)
    Frontend->>User: Update chat, flashcards, mindmap
```

## Message Lifecycle

```mermaid
graph LR
    A["1. User Message<br/>Arrives"] -->|POST /chat| B["2. Store in<br/>messages table<br/>(initial)"]
    B --> C["3. Agent<br/>Processes"]
    C -->|streams| D["4. Response<br/>Shown to User"]
    C -->|bg task| E["5. Determine<br/>Topic"]
    E -->|LLM| F["6. Classify into<br/>40 Topics"]
    F --> G["7. Update message<br/>topic_id +<br/>subtopic"]
    G --> H["messages table<br/>now complete"]
    
    C -->|bg task| I["8. Extract<br/>Flashcard"]
    I -->|LLM| J["9. Q&A<br/>Generation"]
    J --> K["10. Check<br/>Duplicate"]
    K -->|similar| L["Skip"]
    K -->|new| M["11. Get Embedding"]
    M -->|openai| N["12. Store<br/>Flashcard<br/>with topic_id"]
    
    C -->|bg task| O["13. Recompute<br/>Mindmap"]
    O --> P["14. Query messages<br/>by topic_id"]
    P --> Q["15. Build graph<br/>Nodes & Edges"]
    Q --> R["16. Cache in<br/>mindmap_cache"]
    
    H --> S["Final State:<br/>Message + Topic<br/>+ Embedding"]
    N --> T["Flashcard<br/>Ready for<br/>Review"]
    R --> U["Mindmap<br/>Updated"]
```

## Component Details

### Topic Determiner Service (New)

Responsible for classifying messages into pre-seeded topics.

```mermaid
graph TD
    A["Message Received"] --> B["Load 40 Pre-seeded<br/>Topics from DB"]
    B --> C["Build Prompt"]
    C --> D["Call OpenAI<br/>classify_topic()"]
    D --> E["Parse Response:<br/>topic_id +<br/>subtopic"]
    E --> F["Validate topic_id<br/>exists"]
    F --> G["Update messages<br/>table"]
    G --> H["Emit Event:<br/>topic_assigned"]
```

**Implementation**: `src/topic-determiner.ts` (to be created)

**Key Methods**:
- `determine(message: string): Promise<{ topicId: number; subtopic: string }>`
- `validateTopic(topicId: number): Promise<boolean>`

**Prompt Template**:
```
You have these 40 topics available:
[LIST OF TOPICS]

Classify this message into one of the above topics and provide a specific subtopic.

Message: [MESSAGE]

Respond as JSON: {
  "topicId": <number>,
  "topicLabel": "...",
  "subtopic": "..."
}
```

### Flashcard Extractor Service

```mermaid
graph TD
    A["User Message +<br/>Assistant Response"] --> B["Extract Q&A<br/>Pair"]
    B -->|LLM| C["Does it teach<br/>a fact?"]
    C -->|no| D["Skip"]
    C -->|yes| E["Get Embedding<br/>of Question"]
    E --> F["Check Vector<br/>Similarity"]
    F -->|< 0.15 distance| G["Deduplicate<br/>Check"]
    F -->|> 0.15| H["New Flashcard"]
    G -->|LLM| I["Same<br/>Concept?"]
    I -->|yes| J["Skip<br/>Duplicate"]
    I -->|no| H
    H --> K["Get topic_id<br/>from message"]
    K --> L["INSERT<br/>flashcard<br/>with topic_id FK"]
```

**Current**: `src/flashcard-extractor.ts`

**Changes Required**:
- Instead of finding topic from mindmap, use message's `topic_id`
- Change `topic_label` column to `topic_id` (foreign key)

### Mindmap Service

```mermaid
graph TD
    A["Recompute Called"] --> B["Query all messages<br/>grouped by topic_id"]
    B --> C["For each topic<br/>with messages:"]
    C --> D["Get top 3 recent<br/>messages"]
    D --> E["Extract facts<br/>from each<br/>using LLM"]
    E --> F["Build React Flow<br/>Graph"]
    F -->|center node| G["All Topics"]
    F -->|topic nodes| H["One per topic<br/>with count"]
    F -->|fact nodes| I["Up to 3 facts<br/>per topic"]
    G --> J["Cache to<br/>mindmap_cache<br/>as JSON"]
```

**Current**: `src/mindmap.ts`

**Changes Required**:
- Replace k-means clustering with GROUP BY topic_id
- Simplify label generation (use topic_label from topics table)
- Add subtopic rendering to nodes

### Flashcard Service (SM-2 Algorithm)

```mermaid
graph TD
    A["Review Score<br/>Submitted"] --> B["Look up<br/>Flashcard"]
    B --> C["Get Current<br/>SM-2 State"]
    C --> D["Calculate<br/>Next Review<br/>Using SM-2"]
    D --> E["Update:<br/>interval_days,<br/>ease_factor,<br/>repetitions"]
    E --> F["Set next_due_at"]
    F --> G["Log Review<br/>in flashcard_reviews"]
    G --> H["Return<br/>next_due_at"]
```

**Current**: `src/flashcard-service.ts`

**No Changes Required** - this stays the same, just now uses `topic_id` instead of `topic_label`.

## Data Flow: Topic Assignment

### Before (Dynamic Clustering)
```
Message → Embedding → k-means Clustering → Dynamic Topic Label → Flashcard
                      ↓
                   Mindmap Cache (computed)
```

### After (Pre-seeded Topics)
```
Message → Store in DB → Topic Determiner (LLM) → topic_id FK → Flashcard
                        ↓
                     Update messages table
                        ↓
                   Mindmap Service queries by topic_id → Cache
```

## Database Changes

### New Table: topics

```sql
CREATE TABLE topics (
  id    BIGSERIAL PRIMARY KEY,
  label TEXT UNIQUE NOT NULL
);

-- Insert 40 pre-seeded topics
INSERT INTO topics (label) VALUES
  ('Fitness'), ('Cardio Training'), ('Strength Training'),
  ('Nutrition'), ('Sleep'), ('Yoga'), ('Meditation'),
  ('Finance'), ('Budgeting'), ('Saving'),
  ('Investing'), ('Debt Management'), ('Cryptocurrency'),
  ('Food'), ('Recipes'), ('Cooking'),
  ('Restaurants'), ('Diet'), ('Nutrition Tips'),
  ... (28 more topics)
```

### Modified: messages

```sql
ALTER TABLE messages ADD COLUMN topic_id BIGINT REFERENCES topics(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN subtopic TEXT;
```

### Modified: flashcards

```sql
-- Change from topic_label to topic_id
ALTER TABLE flashcards DROP COLUMN topic_label;
ALTER TABLE flashcards ADD COLUMN topic_id BIGINT REFERENCES topics(id) ON DELETE SET NULL;
```

## API Changes

No changes to API routes, but response shapes expand:

**GET /history** now returns:
```json
{
  "id": 1,
  "role": "user",
  "content": "...",
  "topicId": 5,
  "subtopic": "cardio training",
  "createdAt": "..."
}
```

**GET /mindmap** nodes now include subtopic info:
```json
{
  "id": "topic-5",
  "type": "topic",
  "data": {
    "label": "Fitness",
    "subtopics": ["cardio training", "strength training"],
    "color": "#3b82f6"
  }
}
```

## Performance Characteristics

| Operation | Complexity | Notes |
|-----------|-----------|-------|
| Message Insert | O(1) | Single row insert |
| Topic Determination | O(1) | One LLM call (async) |
| Flashcard Extraction | O(n) | n = embeddings to compare (async) |
| Mindmap Recomputation | O(m log m) | m = messages, grouped by topic, cached |
| Vector Search | O(log n) | HNSW index on embeddings |
| Flashcard Review | O(1) | Single update |

**Key: All background operations are non-blocking and fire-and-forget**

## Error Handling Strategy

```mermaid
graph TD
    A["Operation"] --> B{Blocking<br/>or BG?}
    B -->|Blocking| C["Throw Error<br/>to User"]
    B -->|Background| D{Critical?}
    D -->|Yes| E["Log Error<br/>& Retry"]
    D -->|No| F["Log Error<br/>Continue"]
    
    E --> G["Flashcard<br/>Extraction<br/>Fails?"]
    G -->|yes| H["Continue chat<br/>without flashcard"]
    
    F --> I["Mindmap<br/>Recompute<br/>Fails?"]
    I -->|yes| J["Return cached<br/>mindmap"]
    
    F --> K["Topic<br/>Assignment<br/>Fails?"]
    K -->|yes| L["Message stored<br/>without topic"]
```

**Message Saving**: Always succeeds (blocking)
**Topic Assignment**: Fails gracefully, message still stored
**Flashcard Extraction**: Fails gracefully, chat continues
**Mindmap Recompute**: Returns cached version if fails

## Deployment Architecture

### Development
```
npm run dev
├── Vite dev server (frontend) :5173
└── ts-node api-server.ts (backend) :3000
```

### Production
```
npm run build
npm start
└── Single Express server serving compiled UI :3000
    └── Bundles UI dist/ui/index.html as static
```

### Database
- **Local Dev**: Docker PostgreSQL container
- **Staging/Prod**: Managed PostgreSQL (RDS, Heroku, etc.)
  - Must have pgvector extension enabled
  - Must have sufficient connection pool (20-50 depending on load)

## Scalability Considerations

### Read Scaling
- Message history: Limited to last N (default 50)
- Flashcards: Limited to due cards only
- Mindmap: Single cached copy, expires on recompute

### Write Scaling
- Flashcard writes: One per conversation turn (low volume)
- Message writes: One per conversation turn
- Topic assignments: Async, non-blocking
- Embeddings: One per unique message content

### Vector Search Scaling
- HNSW index handles ~1M vectors efficiently
- Cosine distance metric in production
- Background cleanup of old embeddings not implemented (TODO)

## Security Considerations

- **API Keys**: OPENAI_API_KEY in .env (not in repo)
- **Database**: Connection string in DATABASE_URL (not in repo)
- **User Data**: Messages stored in database, no encryption at rest
- **Rate Limiting**: Not implemented (add if exposing publicly)
- **Input Validation**: Basic string trimming only (add validation layer if needed)

## Testing Strategy

```mermaid
graph TD
    A["Unit Tests"] -->|test each service| B["Service Logic"]
    C["Integration Tests"] -->|test DB interactions| D["Database Layer"]
    E["E2E Tests"] -->|test full flow| F["API Endpoints"]
    
    G["Test Data"] -->|seed topics| H["Pre-seeded Topics"]
    G -->|sample messages| I["6 Sample Messages"]
    
    J["CI/CD"] -->|run on PR| K["npm test"]
    K -->|then build| L["npm run build"]
    L -->|then check types| M["tsc --noEmit"]
```

## Migration Path

1. **Phase 1**: Add topics table, seed 40 topics
2. **Phase 2**: Add topic_id + subtopic columns to messages
3. **Phase 3**: Create TopicDeterminer service
4. **Phase 4**: Update message processing to call TopicDeterminer
5. **Phase 5**: Update Mindmap to use topic_id instead of clustering
6. **Phase 6**: Update Flashcard to use topic_id FK instead of topic_label
7. **Phase 7**: Migrate existing flashcard_labels to topic_ids (if any)
8. **Phase 8**: Update UI to render subtopics in mindmap
