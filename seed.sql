-- Seed messages across 3 topics: weather, health, finance
INSERT INTO messages (role, content, source) VALUES
  ('user',      'What is the weather like in London today?',                       'user'),
  ('assistant', 'London is currently 14°C with light rain and overcast skies.',    'weather-agent'),
  ('user',      'Will it be sunny in Paris this weekend?',                         'user'),
  ('assistant', 'Paris looks clear on Saturday, 22°C, with clouds on Sunday.',     'weather-agent'),
  ('user',      'What is the UV index in Tokyo tomorrow?',                         'user'),

  ('user',      'How much water should I drink each day?',                         'user'),
  ('assistant', 'Most adults need around 2 litres of water per day.',              'weather-agent'),
  ('user',      'What are the benefits of walking 10,000 steps a day?',            'user'),
  ('assistant', 'Daily walking improves cardiovascular health and mood.',          'weather-agent'),
  ('user',      'How many hours of sleep does an adult need?',                     'user'),

  ('user',      'What is a good way to start saving money?',                       'user'),
  ('assistant', 'Start with a monthly budget and automate a savings transfer.',    'weather-agent'),
  ('user',      'Should I invest in index funds or individual stocks?',            'user'),
  ('assistant', 'Index funds offer diversification and lower risk for beginners.', 'weather-agent'),
  ('user',      'What is compound interest and why does it matter?',               'user');

-- Pre-built mindmap graph so the UI works immediately without real embeddings
INSERT INTO mindmap_cache (id, graph) VALUES (1, '{
  "nodes": [
    {"id":"center",   "type":"center","data":{"label":"All Topics"}},
    {"id":"topic-0",  "type":"topic", "data":{"label":"Weather", "color":"#3b82f6"}},
    {"id":"topic-1",  "type":"topic", "data":{"label":"Health",  "color":"#22c55e"}},
    {"id":"topic-2",  "type":"topic", "data":{"label":"Finance", "color":"#f97316"}},
    {"id":"fact-0-0", "type":"fact",  "data":{"label":"Asked about London, Paris, Tokyo"}},
    {"id":"fact-0-1", "type":"fact",  "data":{"label":"Interested in UV index"}},
    {"id":"fact-1-0", "type":"fact",  "data":{"label":"Curious about daily habits"}},
    {"id":"fact-1-1", "type":"fact",  "data":{"label":"Sleep and hydration questions"}},
    {"id":"fact-2-0", "type":"fact",  "data":{"label":"Saving and budgeting focus"}},
    {"id":"fact-2-1", "type":"fact",  "data":{"label":"Asked about index funds"}}
  ],
  "edges": [
    {"id":"e-c-0",  "source":"center",  "target":"topic-0"},
    {"id":"e-c-1",  "source":"center",  "target":"topic-1"},
    {"id":"e-c-2",  "source":"center",  "target":"topic-2"},
    {"id":"e-0-f0", "source":"topic-0", "target":"fact-0-0"},
    {"id":"e-0-f1", "source":"topic-0", "target":"fact-0-1"},
    {"id":"e-1-f0", "source":"topic-1", "target":"fact-1-0"},
    {"id":"e-1-f1", "source":"topic-1", "target":"fact-1-1"},
    {"id":"e-2-f0", "source":"topic-2", "target":"fact-2-0"},
    {"id":"e-2-f1", "source":"topic-2", "target":"fact-2-1"}
  ],
  "updatedAt": "2026-05-03T00:00:00Z"
}')
ON CONFLICT (id) DO NOTHING;
