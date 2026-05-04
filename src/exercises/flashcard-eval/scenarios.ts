import type { FlashcardScenario } from './types';

export const scenarios: FlashcardScenario[] = [
  {
    id: 'overdue-fail',
    description: 'Single card, 14 days overdue, last score = fail',
    mockMindmapTopics: ['Weather', 'Geography'],
    mockDueCards: [
      { id: 1, question: 'What is the capital of France?', topicLabel: 'Geography', lastScore: 'fail', daysOverdue: 14 },
    ],
    expectedBehavior: 'Selects card id 1 — the only available card, which is overdue and previously failed.',
  },
  {
    id: 'topic-variety',
    description: '3 Geography cards + 1 History card, all equally due',
    mockMindmapTopics: ['Weather', 'Geography', 'History'],
    mockDueCards: [
      { id: 2, question: 'What is the capital of Germany?', topicLabel: 'Geography', lastScore: 'easy', daysOverdue: 0 },
      { id: 3, question: 'What is the capital of Spain?',   topicLabel: 'Geography', lastScore: 'easy', daysOverdue: 0 },
      { id: 4, question: 'What is the capital of Italy?',  topicLabel: 'Geography', lastScore: 'easy', daysOverdue: 0 },
      { id: 5, question: 'What year did WW2 end?',         topicLabel: 'History',   lastScore: 'easy', daysOverdue: 0 },
    ],
    expectedBehavior: 'Selects card id 5 (History topic) to introduce variety rather than a fourth Geography card.',
  },
  {
    id: 'no-cards',
    description: 'get_due_flashcards returns an empty array',
    mockMindmapTopics: ['Weather'],
    mockDueCards: [],
    expectedBehavior: 'Returns {"id": null} — no cards available, no hallucinated card id.',
  },
  {
    id: 'fail-vs-easy',
    description: 'Two equally overdue cards — one previously fail, one previously easy',
    mockMindmapTopics: ['Weather'],
    mockDueCards: [
      { id: 6, question: 'What causes thunder?',         topicLabel: 'Weather', lastScore: 'fail', daysOverdue: 3 },
      { id: 7, question: 'What is the Coriolis effect?', topicLabel: 'Weather', lastScore: 'easy', daysOverdue: 3 },
    ],
    expectedBehavior: 'Selects card id 6 (lastScore=fail) over card id 7 (lastScore=easy).',
  },
  {
    id: 'never-reviewed',
    description: 'One never-reviewed card available, no overdue cards',
    mockMindmapTopics: ['History'],
    mockDueCards: [
      { id: 8, question: 'Who was Napoleon Bonaparte?', topicLabel: 'History', lastScore: null, daysOverdue: 0 },
    ],
    expectedBehavior: 'Selects card id 8 — never-reviewed cards should be prioritised when nothing is overdue.',
  },
];
