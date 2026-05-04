export interface DueCardMock {
  id: number;
  question: string;
  topicLabel: string | null;
  lastScore: string | null;
  daysOverdue: number;
}

export interface FlashcardScenario {
  id: string;
  description: string;
  mockMindmapTopics: string[];
  mockDueCards: DueCardMock[];
  expectedBehavior: string;
}

export interface JudgeScore {
  judgeName: string;
  score: number;
  justification: string;
}

export interface EvalResult {
  scenarioId: string;
  scenarioDescription: string;
  agentResponse: string;
  selectedCardId: number | null;
  judgeScores: JudgeScore[];
  averageScore: number;
}
