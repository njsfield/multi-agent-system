import { OpenAIChatClient } from '../../client';
import type { FlashcardScenario, JudgeScore } from './types';

abstract class LLMJudge {
  protected client = new OpenAIChatClient('gpt-4o-mini');
  abstract criteriaPrompt: string;

  get judgeName(): string { return this.constructor.name; }

  async judge(scenario: FlashcardScenario, agentResponse: string): Promise<JudgeScore> {
    const result = await this.client.create([
      {
        role: 'system',
        content: 'You are evaluating a spaced repetition card selection agent. Score 0–10. Respond with JSON only: {"score": number, "justification": string}',
        source: 'system',
        timestamp: new Date(),
      },
      {
        role: 'user',
        content: `${this.criteriaPrompt}\n\nScenario: ${scenario.description}\nExpected: ${scenario.expectedBehavior}\nAvailable cards: ${JSON.stringify(scenario.mockDueCards)}\nAgent response: ${agentResponse}`,
        source: 'user',
        timestamp: new Date(),
      },
    ]);

    try {
      const parsed = JSON.parse(result.message.content) as { score: number; justification: string };
      return { judgeName: this.judgeName, score: parsed.score, justification: parsed.justification };
    } catch {
      return { judgeName: this.judgeName, score: 0, justification: 'Failed to parse judge response' };
    }
  }
}

export class SelectionReasoningJudge extends LLMJudge {
  criteriaPrompt = 'Evaluate whether the agent clearly reasoned about WHY it selected the card it chose, citing relevant factors like daysOverdue, lastScore, or topic variety.';
}

export class PriorityJudge extends LLMJudge {
  criteriaPrompt = 'Evaluate whether the agent selected the correct card per SM-2 priority rules: fail/hard and overdue > never-reviewed > easy/very_easy; topic variety as tiebreaker. Score 0 if the wrong card was chosen when a clearly better card was available.';
}

export class EdgeCaseJudge extends LLMJudge {
  criteriaPrompt = 'Evaluate whether the agent handled the no-cards case by returning {"id": null} without hallucinating a card id. For scenarios with available cards, score 10 if a valid integer card id was returned.';
}
