-- ============================================================================
-- Seed data for TS-Agent system
-- ============================================================================
-- This script populates:
-- - 40 pre-defined topics across 3 categories (Fitness, Finance, Food)
-- - 6 sample messages with pre-assigned topics and subtopics
--
-- Load with: psql -U admin -d tsagent -f seed-data.sql
-- Or via Docker: docker exec -i tsagent-db psql -U admin -d tsagent < seed-data.sql
--
-- Note: Embeddings are generated automatically when messages are added through
-- the API. This seed data focuses on topics and message content.
-- ============================================================================

\c tsagent admin

-- ============================================================================
-- Fitness Topics (13 total)
-- ============================================================================

INSERT INTO topics (label) VALUES
  ('Fitness'),
  ('Cardio Training'),
  ('Strength Training'),
  ('Flexibility & Stretching'),
  ('Yoga'),
  ('Pilates'),
  ('Meditation'),
  ('Sleep & Recovery'),
  ('Nutrition'),
  ('Hydration'),
  ('Injury Prevention'),
  ('Athletic Performance'),
  ('Personal Training');

-- ============================================================================
-- Finance Topics (14 total)
-- ============================================================================

INSERT INTO topics (label) VALUES
  ('Finance'),
  ('Budgeting'),
  ('Saving & Emergency Fund'),
  ('Investing'),
  ('Stock Market'),
  ('Cryptocurrency'),
  ('Real Estate'),
  ('Debt Management'),
  ('Credit & Credit Score'),
  ('Taxes'),
  ('Retirement Planning'),
  ('Insurance'),
  ('Side Income & Freelance'),
  ('Career Growth');

-- ============================================================================
-- Food Topics (13 total)
-- ============================================================================

INSERT INTO topics (label) VALUES
  ('Food'),
  ('Recipes'),
  ('Cooking Techniques'),
  ('Baking'),
  ('Cuisine Styles'),
  ('Meal Planning'),
  ('Food Safety'),
  ('Dietary Approaches'),
  ('Restaurants & Dining'),
  ('Ingredients & Substitutions'),
  ('Food Pairing & Wine'),
  ('Kitchen Equipment'),
  ('Food Trends');

-- ============================================================================
-- Sample Messages (6 total) - 3 categories, 2 messages each
-- ============================================================================

-- Fitness: Message 1
INSERT INTO messages (role, content, source, topic_id, subtopic) VALUES
  ('user', 'What are the best cardio exercises to improve heart health and endurance?', 'user',
   (SELECT id FROM topics WHERE label = 'Cardio Training'),
   'heart health and cardiovascular endurance');

INSERT INTO messages (role, content, source, topic_id, subtopic) VALUES
  ('assistant', 'The best cardio exercises for heart health include running, cycling, swimming, and rowing. Aim for 150 minutes of moderate-intensity cardio per week. High-intensity interval training (HIIT) is also excellent for building endurance quickly. Start with 30-minute sessions at a comfortable pace, then gradually increase intensity.', 'assistant',
   (SELECT id FROM topics WHERE label = 'Cardio Training'),
   'cardiovascular training methods and schedules');

-- Finance: Message 1
INSERT INTO messages (role, content, source, topic_id, subtopic) VALUES
  ('user', 'How should I build an investment portfolio for long-term wealth?', 'user',
   (SELECT id FROM topics WHERE label = 'Investing'),
   'long-term portfolio construction');

INSERT INTO messages (role, content, source, topic_id, subtopic) VALUES
  ('assistant', 'Start with a diversified portfolio: 60% stocks, 30% bonds, 10% alternatives. For beginners, use low-cost index funds or ETFs. Consider your risk tolerance and time horizon. Allocate by age: stock percentage = 110 minus your age. Rebalance annually. Dollar-cost averaging helps reduce market timing risk.', 'assistant',
   (SELECT id FROM topics WHERE label = 'Investing'),
   'asset allocation and diversification strategies');

-- Food: Message 1
INSERT INTO messages (role, content, source, topic_id, subtopic) VALUES
  ('user', 'What are some quick and healthy recipe ideas for busy weeknights?', 'user',
   (SELECT id FROM topics WHERE label = 'Recipes'),
   'quick weeknight meal preparation');

INSERT INTO messages (role, content, source, topic_id, subtopic) VALUES
  ('assistant', 'Try sheet pan dinners: roast proteins with vegetables, 20-30 minutes. One-pot pasta dishes are fast and nutritious. Stir-fries with pre-cut vegetables take 15 minutes. Slow cooker meals prep in morning, ready at night. Buddha bowls combine grains, protein, and veggies. Keep frozen vegetables and canned beans on hand for quick assembly.', 'assistant',
   (SELECT id FROM topics WHERE label = 'Recipes'),
   'efficient cooking methods for busy schedules');

-- ============================================================================
-- Verification queries
-- ============================================================================

SELECT '=== TOPICS ===' AS verification;
SELECT COUNT(*) as total_topics FROM topics;

SELECT '' AS separator;
SELECT 'Topics by category:' AS info;
SELECT
  CASE
    WHEN label IN ('Fitness', 'Cardio Training', 'Strength Training', 'Flexibility & Stretching', 'Yoga', 'Pilates', 'Meditation', 'Sleep & Recovery', 'Nutrition', 'Hydration', 'Injury Prevention', 'Athletic Performance', 'Personal Training') THEN 'Fitness'
    WHEN label IN ('Finance', 'Budgeting', 'Saving & Emergency Fund', 'Investing', 'Stock Market', 'Cryptocurrency', 'Real Estate', 'Debt Management', 'Credit & Credit Score', 'Taxes', 'Retirement Planning', 'Insurance', 'Side Income & Freelance', 'Career Growth') THEN 'Finance'
    WHEN label IN ('Food', 'Recipes', 'Cooking Techniques', 'Baking', 'Cuisine Styles', 'Meal Planning', 'Food Safety', 'Dietary Approaches', 'Restaurants & Dining', 'Ingredients & Substitutions', 'Food Pairing & Wine', 'Kitchen Equipment', 'Food Trends') THEN 'Food'
    ELSE 'Other'
  END AS category,
  COUNT(*) as count
FROM topics
GROUP BY category
ORDER BY category;

SELECT '' AS separator;
SELECT '=== SAMPLE MESSAGES ===' AS verification;
SELECT COUNT(*) as total_messages FROM messages;

SELECT '' AS separator;
SELECT 'Messages by topic:' AS info;
SELECT t.label, COUNT(m.id) as message_count
FROM messages m
LEFT JOIN topics t ON m.topic_id = t.id
GROUP BY t.id, t.label
ORDER BY t.label;

SELECT '' AS separator;
SELECT 'Message details:' AS info;
SELECT
  m.id,
  m.role,
  t.label as topic,
  m.subtopic,
  LENGTH(m.content) as content_length,
  LEFT(m.content, 40) || '...' as preview
FROM messages m
LEFT JOIN topics t ON m.topic_id = t.id
ORDER BY m.id;

SELECT '' AS separator;
SELECT 'Seed data successfully loaded! ✓' AS status;
