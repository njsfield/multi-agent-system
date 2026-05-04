import pg from 'pg';
import { OpenAIAgent } from './openai-agent';
import { FunctionTool } from './tool';
import { FlashcardService } from './flashcard-service';

export const FLASHCARD_AGENT_INSTRUCTIONS = `You are a spaced repetition tutor. Select the single best flashcard for the user to review right now.

Call get_mindmap_topics to see what topics exist, then call get_due_flashcards to see available cards.

Prioritise in this order:
1. Cards with lastScore of "fail" or "hard" that are overdue (daysOverdue > 0)
2. Cards that have never been reviewed (lastScore is null)
3. Cards that are most overdue by daysOverdue

Prefer topic variety — if several cards are equally good candidates, pick from a less-recently-seen topic.

Respond with ONLY a JSON object: {"id": <number>} or {"id": null} if no cards are available. No other text.`;

export function createFlashcardSelectionAgent(pool: pg.Pool): OpenAIAgent {
  const service = new FlashcardService(pool);

  const getMindmapTopicsTool = new FunctionTool(
    async (_params) => {
      try {
        const { rows } = await pool.query<{
          graph: { nodes?: Array<{ type: string; data: { label: string } }> };
        }>('SELECT graph FROM mindmap_cache WHERE id = 1');
        if (!rows[0]) return JSON.stringify([]);
        const topics = (rows[0].graph.nodes ?? [])
          .filter(n => n.type === 'topic')
          .map(n => n.data.label);
        return JSON.stringify(topics);
      } catch {
        return JSON.stringify([]);
      }
    },
    'get_mindmap_topics',
    'Returns an array of topic label strings from the conversation mindmap. Returns [] if no mindmap exists yet.',
    { type: 'object', properties: {}, required: [] },
  );

  const getDueFlashcardsTool = new FunctionTool(
    async (_params) => {
      const cards = await service.getDueCards(10);
      return JSON.stringify(cards);
    },
    'get_due_flashcards',
    'Returns up to 10 flashcards due for review. Each card has: id (number), question (string), topicLabel (string|null), lastScore (string|null), daysOverdue (number).',
    { type: 'object', properties: {}, required: [] },
  );

  return new OpenAIAgent(
    'flashcard-selection-agent',
    FLASHCARD_AGENT_INSTRUCTIONS,
    { tools: [getMindmapTopicsTool, getDueFlashcardsTool] },
  );
}
