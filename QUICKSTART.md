# Quick Start Guide

Get the TS-Agent system running in 5 minutes.

## TL;DR - Fastest Path

```bash
# 1. Start database (one-time)
docker run -d --name tsagent-db -e POSTGRES_USER=admin -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=tsagent -p 5432:5432 pgvector/pgvector:pg16

# 2. Load schema
docker exec tsagent-db psql -U admin -d tsagent -f /dev/stdin < schema.sql

# 3. Install dependencies
npm install

# 4. Configure OpenAI key
echo "OPENAI_API_KEY=sk-proj-your-key-here" >> .env
# (Already has DATABASE_URL=postgresql://admin:postgres@localhost:5432/tsagent)

# 5. Run
npm run dev
```

Then visit **http://localhost:3000** in your browser.

---

## Step-by-Step

### 1. Prerequisites Check

```bash
node --version        # Should be 18+
npm --version         # Should be 8+
docker --version      # For PostgreSQL
```

### 2. Database Setup

#### Using Docker (Recommended)

```bash
# Start container
docker run -d \
  --name tsagent-db \
  -e POSTGRES_USER=admin \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=tsagent \
  -p 5432:5432 \
  pgvector/pgvector:pg16

# Load schema (copy schema.sql content and paste)
docker exec -i tsagent-db psql -U admin -d tsagent < schema.sql

# Verify connection
docker exec tsagent-db psql -U admin -d tsagent -c "SELECT 1"
```

#### Or: Local PostgreSQL

```bash
# Assuming PostgreSQL is installed
createdb -U postgres tsagent
createuser -U postgres admin -P  # password: postgres

# Enable pgvector
psql -U postgres -d tsagent -c "CREATE EXTENSION vector;"

# Load schema
psql -U admin -d tsagent -f schema.sql
```

### 3. Project Setup

```bash
# Install dependencies
npm install

# TypeScript check
npm run typecheck

# Should compile successfully
npm run build
```

### 4. Environment

```bash
# Copy and edit .env (already provided)
# The .env file should have:
# DATABASE_URL=postgresql://admin:postgres@localhost:5432/tsagent
# OPENAI_API_KEY=sk-proj-...

# Verify key is set
grep OPENAI_API_KEY .env
```

### 5. Run

```bash
# Development (frontend hot reload + backend)
npm run dev

# Logs should show:
# > Vite running at...
# > Weather agent → http://localhost:3000
```

Visit **http://localhost:3000** in your browser.

---

## Test the System

### Via Browser UI

1. **Chat Tab**: Type a message about weather
   - "What's the weather in Tokyo tomorrow?"
   - System will fetch live weather and show response

2. **Flashcards Tab**: 
   - Click "Get Flashcard" to review a card
   - Answer with very_easy / easy / hard / fail
   - Check next review date

3. **Mindmap Tab**:
   - See topics and facts extracted from conversation
   - Nodes show key concepts

### Via API

```bash
# Send a message
curl -sN -X POST http://localhost:3000/chat \
  -H 'Content-Type: application/json' \
  -d '{"message": "What is the weather in London?"}'

# Get history
curl http://localhost:3000/history

# Get a flashcard
curl http://localhost:3000/flashcard

# Review it
curl -X POST http://localhost:3000/flashcard/1/review \
  -H 'Content-Type: application/json' \
  -d '{"score": "easy"}'

# View mindmap
curl http://localhost:3000/mindmap
```

---

## Common Issues

| Issue | Solution |
|-------|----------|
| `connect ECONNREFUSED` | Docker not running: `docker start tsagent-db` |
| `Extension "vector" not found` | Not using pgvector image; reinstall with correct image |
| `OPENAI_API_KEY not set` | Edit `.env` and add your OpenAI API key |
| `npm: command not found` | Node.js not installed; install from nodejs.org |
| Port 5432 already in use | Change port: `-p 5433:5432` and update DATABASE_URL |

---

## Project Structure (30-second tour)

```
.
├── src/
│   ├── agent.ts                 # Base agent class
│   ├── openai-agent.ts          # OpenAI implementation
│   ├── mindmap.ts               # Knowledge graph
│   ├── flashcard-*.ts           # Flashcard logic
│   ├── server.ts                # Express routes
│   └── ui/                      # React frontend
├── examples/
│   └── api-server.ts            # Server startup
├── schema.sql                   # Database setup
├── package.json                 # Dependencies
├── tsconfig.json                # TypeScript config
├── vite.config.ts               # Frontend bundler
└── .env                         # Config (not in repo)
```

---

## What Happens When You Chat

```
1. User sends message → API receives it
2. OpenAI processes (streams response to frontend)
3. In background:
   - Topic determination (if topics table seeded)
   - Flashcard extraction (Q&A from conversation)
   - Mindmap recomputation (updates graph cache)
4. Frontend shows chat + flashcards + mindmap
```

---

## Next Steps

1. **Send messages** and watch the system respond
2. **Review flashcards** to test spaced repetition
3. **Seed data** (once topics table is implemented):
   ```bash
   psql -U admin -d tsagent -f seed-data.sql
   ```
4. **Build something**:
   - Add custom tools to the agent
   - Modify prompts in examples/api-server.ts
   - Create new API endpoints

---

## Documentation

- **Setup details**: See README.md
- **Architecture deep-dive**: See ARCHITECTURE.md
- **Implementation plan**: See task list (created earlier)

---

## Stopping

```bash
# Stop the dev server
# Press Ctrl+C in terminal

# Stop database
docker stop tsagent-db

# Clean up (remove container)
docker rm tsagent-db
```

---

## Need Help?

1. Check README.md troubleshooting section
2. Check ARCHITECTURE.md for how components interact
3. Look at examples/api-server.ts for the entry point
4. Run `npm test` to verify everything works
