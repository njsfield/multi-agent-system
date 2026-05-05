-- Seed data for 40 common topics across 3 categories

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
-- Verify data was inserted
-- ============================================================================

SELECT 'Topics created:' AS status;
SELECT COUNT(*) as total_topics FROM topics;
SELECT label FROM topics ORDER BY label;

SELECT '' AS blank;
SELECT 'Sample messages created:' AS status;
SELECT COUNT(*) as total_messages FROM messages;
SELECT role, topic_id, subtopic, LEFT(content, 50) || '...' as preview FROM messages;
