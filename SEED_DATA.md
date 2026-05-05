# Seed Data for TS-Agent

This document describes the pre-seeded data that comes with TS-Agent.

## Overview

The seed data includes:
- **40 pre-defined topics** organized into 3 categories
- **6 sample messages** distributed across those topics
- **Complete topic assignments** for all sample messages

## Topics (40 total)

### Fitness (13 topics)
Topics related to physical health, exercise, and wellness:
- Fitness, Cardio Training, Strength Training, Flexibility & Stretching
- Yoga, Pilates, Meditation, Sleep & Recovery
- Nutrition, Hydration, Injury Prevention, Athletic Performance
- Personal Training

### Finance (14 topics)
Topics related to money management and investments:
- Finance, Budgeting, Saving & Emergency Fund, Investing
- Stock Market, Cryptocurrency, Real Estate, Debt Management
- Credit & Credit Score, Taxes, Retirement Planning, Insurance
- Side Income & Freelance, Career Growth

### Food (13 topics)
Topics related to cooking, dining, and culinary arts:
- Food, Recipes, Cooking Techniques, Baking
- Cuisine Styles, Meal Planning, Food Safety, Dietary Approaches
- Restaurants & Dining, Ingredients & Substitutions, Food Pairing & Wine
- Kitchen Equipment, Food Trends

## Sample Messages (6 total)

### Fitness: Cardio Training
**Topic**: Cardio Training  
**Subtopic**: Heart health and cardiovascular endurance

**Message 1 (User)**: "What are the best cardio exercises to improve heart health and endurance?"

**Message 2 (Assistant)**: "The best cardio exercises for heart health include running, cycling, swimming, and rowing. Aim for 150 minutes of moderate-intensity cardio per week. High-intensity interval training (HIIT) is also excellent for building endurance quickly. Start with 30-minute sessions at a comfortable pace, then gradually increase intensity."

---

### Finance: Investing
**Topic**: Investing  
**Subtopic**: Long-term portfolio construction

**Message 1 (User)**: "How should I build an investment portfolio for long-term wealth?"

**Message 2 (Assistant)**: "Start with a diversified portfolio: 60% stocks, 30% bonds, 10% alternatives. For beginners, use low-cost index funds or ETFs. Consider your risk tolerance and time horizon. Allocate by age: stock percentage = 110 minus your age. Rebalance annually. Dollar-cost averaging helps reduce market timing risk."

---

### Food: Recipes
**Topic**: Recipes  
**Subtopic**: Quick weeknight meal preparation

**Message 1 (User)**: "What are some quick and healthy recipe ideas for busy weeknights?"

**Message 2 (Assistant)**: "Try sheet pan dinners: roast proteins with vegetables, 20-30 minutes. One-pot pasta dishes are fast and nutritious. Stir-fries with pre-cut vegetables take 15 minutes. Slow cooker meals prep in morning, ready at night. Buddha bowls combine grains, protein, and veggies. Keep frozen vegetables and canned beans on hand for quick assembly."

## Loading Seed Data

### Option 1: Using the helper script (Recommended)

```bash
# From the project root
./scripts/load-seed-data.sh

# With custom database settings
DB_HOST=myhost DB_PORT=5433 DB_USER=myuser ./scripts/load-seed-data.sh
```

### Option 2: Direct psql command

**Local PostgreSQL:**
```bash
psql -U admin -d tsagent -f seed-data.sql
```

**Docker PostgreSQL:**
```bash
docker exec -i tsagent-db psql -U admin -d tsagent < seed-data.sql
```

### Option 3: From within psql

```sql
\c tsagent admin
\i seed-data.sql
```

## Verification

After loading, verify the data was inserted correctly:

```sql
-- Check topics
SELECT COUNT(*) FROM topics;           -- Should return 40
SELECT COUNT(DISTINCT label) FROM topics;  -- Should return 40

-- Check messages
SELECT COUNT(*) FROM messages;         -- Should return 6
SELECT role, COUNT(*) FROM messages GROUP BY role;  -- 3 user, 3 assistant

-- Check topic assignments
SELECT t.label, COUNT(m.id) as count
FROM messages m
LEFT JOIN topics t ON m.topic_id = t.id
GROUP BY t.label
ORDER BY t.label;  -- Should show 3 topics with 2 messages each
```

## After Loading Seed Data

Once seed data is loaded, you can:

1. **Start the server** and view the sample messages in the chat history
2. **Generate embeddings** - When the server runs, embeddings are created for seed messages
3. **Create flashcards** - The system will extract Q&A from the sample messages
4. **View the mindmap** - Topics will appear in the knowledge graph with related messages
5. **Test topic classification** - Send new messages and watch them get classified into the 40 topics

## Resetting Seed Data

To clear and reload seed data:

```bash
# Connect to database
psql -U admin -d tsagent

# Clear existing data (careful!)
DELETE FROM messages;          -- Deletes messages (cascades to embeddings)
DELETE FROM flashcards;        -- Deletes flashcards
DELETE FROM topics;            -- Deletes topics

-- Then reload
\i seed-data.sql
```

Or use the shell script again - it will insert the seed data (but won't clear existing data first).

## Customizing Seed Data

To add your own messages to the seed data:

1. Edit `seed-data.sql`
2. Add new topic if needed:
   ```sql
   INSERT INTO topics (label) VALUES ('Your New Topic');
   ```
3. Add messages with the topic_id:
   ```sql
   INSERT INTO messages (role, content, source, topic_id, subtopic) VALUES
     ('user', 'Your question here', 'user',
      (SELECT id FROM topics WHERE label = 'Your New Topic'),
      'specific variation');
   ```
4. Reload seed data

## Notes

- **Embeddings**: Message embeddings are NOT included in seed data. They're generated automatically when the system processes messages through the API.
- **Flashcards**: Sample flashcards are NOT pre-generated. They're created when messages flow through the extraction pipeline.
- **Topic Assignment**: Seed messages have manually assigned topics. New messages added through the API will be auto-classified by the TopicDeterminationAgent.
- **Idempotent**: The seed script uses `INSERT` (not `INSERT ... ON CONFLICT`), so running it multiple times will duplicate data. Use `DELETE` to clear first if reloading.

## Data Structure

```
topics (40)
  ├─ Fitness (13)
  ├─ Finance (14)
  └─ Food (13)

messages (6)
  ├─ Fitness: Cardio Training (2)
  ├─ Finance: Investing (2)
  └─ Food: Recipes (2)
```

Each message includes:
- `role`: 'user' or 'assistant'
- `content`: The message text
- `source`: Message origin ('user', 'assistant', etc.)
- `topic_id`: FK to topics table
- `subtopic`: Specific variation of the topic
