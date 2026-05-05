# TS-Agent: Multi-Agent System with Topics, Flashcards & Mindmap

A TypeScript-based intelligent system that manages conversation topics, automatically generates flashcards for spaced repetition learning, and visualizes knowledge using a dynamic mindmap.

## Overview

The TS-Agent system combines several intelligent features:

- **Multi-Agent Orchestration**: OpenAI-based agents with tool use and streaming
- **Topic Classification**: LLM-based classification of messages into pre-defined topics (40 common topics)
- **Spaced Repetition Learning**: Automatic flashcard extraction with SM-2 algorithm
- **Knowledge Visualization**: Dynamic mindmap using React Flow showing topics and key facts
- **Vector Storage**: PostgreSQL with pgvector for semantic search and embeddings

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         UI Layer (React)                        │
│  ┌────────────────────────────────────────────────────────┐     │
│  │ Chat Interface │ Flashcard Widget │ Mindmap Visualizer │     │
│  └────────────────────────────────────────────────────────┘     │
└────────────────────┬────────────────────────────────────────────┘
                     │ HTTP SSE
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                     API Server (Express)                         │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ POST /chat (streaming)  GET /history  GET /flashcard     │   │
│  │ POST /flashcard/:id/review  GET /mindmap                 │   │
│  └──────────────────────────────────────────────────────────┘   │
└────────────────────┬───────────────────────────────────────────┘
                     │
      ┌──────────────┼──────────────┐
      ▼              ▼              ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│   OpenAI     │ │  PostgreSQL  │ │   Services   │
│  (API Keys)  │ │  + pgvector  │ │              │
└──────────────┘ └──────────────┘ └──────────────┘
```

## Runtime Flow: Message Processing

When a user submits a message, the following flow occurs:

```mermaid
graph TD
    A["User Submits Message"] -->|POST /chat| B["API Receives Message"]
    B --> C["Message Stored in DB"]
    C --> D["OpenAI Agent Processes"]
    D --> E{Agent Response<br/>Generated}
    E -->|Stream tokens| F["Frontend Receives<br/>Tokens"]
    F --> G["User Reads Response"]
    
    E -->|In Background| H["Topic Determination"]
    H --> I["LLM Classifies into<br/>40 Pre-seeded Topics"]
    I --> J["Assign Topic ID<br/>& Subtopic"]
    J --> K["Update messages table<br/>with topic_id, subtopic"]
    
    E -->|In Background| L["Create Embedding"]
    L --> M["OpenAI embedding API"]
    M --> N["Store in message_embeddings"]
    
    E -->|In Background| O["Flashcard Extraction"]
    O --> P["Extract Q&A from<br/>conversation"]
    P --> Q["Deduplicate &<br/>Find Topic"]
    Q --> R["Store flashcard<br/>with topic_id FK"]
    
    F --> X["Response Complete"]
    X --> Y["Frontend now shows:<br/>chat, flashcards"]
    Y --> Z["GET /mindmap generates<br/>fresh graph from DB"]
    Z --> AA["Frontend displays<br/>mindmap with topics<br/>and facts"]
```

## Prerequisites

- **Node.js** 18+
- **PostgreSQL** 14+ (with pgvector extension)
- **OpenAI API Key** (for Claude/GPT models)

## Local Setup

### 1. Clone & Install Dependencies

```bash
cd ts-agent
npm install
```

### 2. Set Up PostgreSQL

#### Option A: Using Docker (Recommended)

```bash
# Start PostgreSQL with pgvector
docker run -d \
  --name tsagent-db \
  -e POSTGRES_USER=admin \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=tsagent \
  -p 5432:5432 \
  pgvector/pgvector:pg16
```

#### Option B: Local PostgreSQL Installation

Ensure PostgreSQL is running and create the database:

```sql
CREATE USER admin WITH PASSWORD 'postgres';
CREATE DATABASE tsagent OWNER admin;

-- Connect to tsagent database
\c tsagent postgres

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

\c tsagent admin
```

Then apply the schema:

```bash
psql -U admin -d tsagent -f schema.sql
```

### 3. Configure Environment

Create `.env` file with your OpenAI API key:

```env
DATABASE_URL=postgresql://admin:postgres@localhost:5432/tsagent
OPENAI_API_KEY=sk-proj-your-api-key-here
```

### 4. Seed Initial Data (Optional)

Load sample topics and messages:

```bash
psql -U admin -d tsagent -f seed-data.sql
```

## Running Locally

### Development Mode (with UI hot reload)

```bash
npm run dev
```

This starts:
- **Frontend** (Vite): http://localhost:5173
- **API Server**: http://localhost:3000

The API server serves the compiled UI at http://localhost:3000.

### Production Build

```bash
npm run build
npm start
```

## API Usage

### POST /chat - Send Message (Streaming)

Send a message and stream the response:

```bash
curl -sN -X POST http://localhost:3000/chat \
  -H 'Content-Type: application/json' \
  -d '{"message": "Tell me about fitness routines"}'
```

Response is Server-Sent Events (SSE):

```json
{"type":"token","content":"Here","source":"assistant"}
{"type":"token","content":" are","source":"assistant"}
...
{"type":"done"}
```

### GET /history - Message History

Retrieve conversation history:

```bash
curl http://localhost:3000/history?limit=20
```

Response:

```json
[
  {
    "id": 1,
    "role": "user",
    "content": "Tell me about fitness routines",
    "source": "user",
    "topicId": 5,
    "subtopic": "cardio training",
    "createdAt": "2026-05-05T10:30:00Z"
  },
  ...
]
```

### GET /flashcard - Get Due Flashcard

Retrieve a due flashcard for review:

```bash
curl http://localhost:3000/flashcard
```

Response:

```json
{
  "id": 42,
  "question": "What is the SM-2 spaced repetition algorithm?",
  "answer": "A widely-used algorithm for calculating optimal review intervals...",
  "topicLabel": "Fitness"
}
```

### POST /flashcard/:id/review - Review Flashcard

Submit a review score (very_easy, easy, hard, fail):

```bash
curl -X POST http://localhost:3000/flashcard/42/review \
  -H 'Content-Type: application/json' \
  -d '{"score": "easy"}'
```

Response:

```json
{"nextDueAt": "2026-05-11T10:30:00Z"}
```

### GET /mindmap - Get Knowledge Graph

Retrieve the current mindmap:

```bash
curl http://localhost:3000/mindmap
```

Response:

```json
{
  "nodes": [
    {"id": "center", "type": "center", "data": {"label": "All Topics"}},
    {"id": "topic-0", "type": "topic", "data": {"label": "Fitness", "color": "#3b82f6"}},
    {"id": "fact-0-0", "type": "fact", "data": {"label": "Cardio improves heart health"}}
  ],
  "edges": [
    {"id": "e-center-0", "source": "center", "target": "topic-0"}
  ],
  "updatedAt": "2026-05-05T10:35:00Z"
}
```

## Project Structure

```
src/
├── agent.ts              # Base agent class
├── openai-agent.ts       # OpenAI-based agent implementation
├── server.ts             # Express server & routes
├── types.ts              # TypeScript type definitions
│
├── services/
│   ├── mindmap.ts        # Knowledge graph generation & clustering
│   ├── flashcard-service.ts    # Spaced repetition (SM-2) algorithm
│   └── flashcard-extractor.ts  # Extract Q&A from conversations
│
├── memory/
│   ├── memory.ts         # In-memory message store (fallback)
│   ├── pg-memory.ts      # PostgreSQL vector store
│   └── context.ts        # Conversation context management
│
├── middleware/
│   ├── middleware.ts     # Base middleware class
│   ├── logging.ts        # Request/response logging
│   ├── otel-middleware.ts  # OpenTelemetry tracing
│   └── markdown.ts       # Markdown detection
│
├── ui/
│   ├── App.tsx           # Main React app
│   ├── components/
│   │   ├── Chat.tsx      # Chat interface
│   │   ├── Mindmap.tsx   # React Flow visualization
│   │   ├── FlashcardWidget.tsx
│   │   └── ...
│   └── hooks/
│       └── useChat.ts    # Chat logic hook
│
└── examples/
    └── api-server.ts     # Server initialization & startup

schema.sql                # Database schema with pgvector
.env                      # Environment variables (not in repo)
package.json              # Dependencies & scripts
tsconfig.json             # TypeScript config
vite.config.ts            # Vite bundler config
```

## Database Schema

### Core Tables

**messages**
- `id` (BIGSERIAL PRIMARY KEY)
- `role` (TEXT): 'user' or 'assistant'
- `content` (TEXT): Message body
- `source` (TEXT): Message source identifier
- `topic_id` (BIGINT FK → topics.id): Pre-seeded topic classification
- `subtopic` (TEXT): Specific variation of the topic
- `created_at` (TIMESTAMPTZ)

**topics**
- `id` (BIGSERIAL PRIMARY KEY)
- `label` (TEXT UNIQUE): Topic name (e.g., "Fitness", "Finance")
- Pre-seeded with 40 common topics

**message_embeddings**
- `id` (BIGSERIAL PRIMARY KEY)
- `message_id` (BIGINT FK → messages.id)
- `content` (TEXT): Embedding text
- `embedding` (VECTOR(1536)): OpenAI embedding
- Indexed with HNSW for vector search

**flashcards**
- `id` (BIGSERIAL PRIMARY KEY)
- `question` (TEXT)
- `answer` (TEXT)
- `topic_id` (BIGINT FK → topics.id): Topic association
- `source_message_id` (BIGINT FK → messages.id): Origin message
- `embedding` (VECTOR(1536)): Question embedding
- SM-2 fields: `interval_days`, `ease_factor`, `repetitions`, `next_due_at`
- Review tracking: `last_reviewed_at`, `created_at`

**flashcard_reviews**
- `id` (BIGSERIAL PRIMARY KEY)
- `flashcard_id` (BIGINT FK → flashcards.id)
- `score` (TEXT): 'very_easy', 'easy', 'hard', 'fail'
- `sm2_quality` (INT): Quality score used in SM-2
- `reviewed_at` (TIMESTAMPTZ)

(Note: mindmap_cache table removed - mindmap is generated at runtime from messages and topics tables)

## Key Concepts

### Topic Classification

When a message is received:
1. LLM reviews the pre-seeded list of 40 topics
2. Determines which topic the message belongs to
3. Assigns a specific subtopic within that category
4. Stores both `topic_id` (FK) and `subtopic` (free text)

### Flashcard Generation

Automatic extraction happens asynchronously:
1. Extracts clear Q&A from user/assistant exchange
2. Checks for duplicates using cosine similarity
3. Assigns `topic_id` from the message's classification
4. Stores with embedding for semantic search

### Spaced Repetition (SM-2)

Flashcards follow the SM-2 algorithm:
- Initial interval: 1 day
- After second review: 6 days
- Subsequent intervals scale with ease factor
- Ease factor adjusts based on review performance

### Mindmap Visualization

The mindmap shows:
- Central node "All Topics"
- One node per topic (from pre-seeded topics table)
- Fact nodes under each topic (extracted from messages)
- Subtopic information rendered in the UI

## Testing

Run the test suite:

```bash
npm test
```

Watch mode for development:

```bash
npm run test:watch
```

## Troubleshooting

### PostgreSQL Connection Error

```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

**Solution**: Ensure PostgreSQL is running:
- Docker: `docker ps | grep tsagent-db`
- Local: `brew services start postgresql` (macOS) or `systemctl start postgresql` (Linux)

### pgvector Extension Not Found

```
ERROR: extension "vector" does not exist
```

**Solution**: Install pgvector extension:
```bash
# Docker: Already included in pgvector/pgvector image
# Local: brew install pgvector (macOS) or apt-get install postgresql-pgvector (Ubuntu)
```

### OpenAI API Key Invalid

```
Error: 401 Unauthorized - Invalid API key
```

**Solution**: Check `.env` file has correct `OPENAI_API_KEY` from https://platform.openai.com/api-keys

### Topics Not Assigned to Messages

If messages don't have `topic_id` values after insertion, ensure:
1. Topic determination service is running (async background task)
2. 40 topics are seeded in the topics table
3. OpenAI API is accessible and quota isn't exceeded

## Performance Considerations

- **Vector Search**: Uses HNSW index on embeddings for O(log n) lookup
- **Mindmap Recomputation**: Runs asynchronously after each message, cached in DB
- **Flashcard Extraction**: Background task, doesn't block chat response
- **Topic Assignment**: LLM call runs in background after message is stored

## Future Enhancements

- [ ] Batch topic determination for multiple messages
- [ ] Custom topic definitions per user
- [ ] Hierarchical topics (parent/child relationships)
- [ ] Multi-language topic classification
- [ ] Advanced mindmap layouts (force-directed, hierarchical)
- [ ] Flashcard image support
- [ ] Integration with spaced repetition review apps

## Contributing

See CONTRIBUTING.md for guidelines.

## License

MIT
