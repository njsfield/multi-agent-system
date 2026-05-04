import path from 'path';
import fs from 'fs';
import { config } from 'dotenv';
import { FunctionTool } from '../../tool';
import { OpenAIAgent } from '../../openai-agent';
import { FLASHCARD_AGENT_INSTRUCTIONS } from '../../flashcard-agent';
import { SelectionReasoningJudge, PriorityJudge, EdgeCaseJudge } from './judges';
import { scenarios } from './scenarios';
import { renderReport } from './report';
import type { EvalResult, FlashcardScenario } from './types';

config({ path: path.join(__dirname, '../../../.env') });

function createEvalAgent(scenario: FlashcardScenario): OpenAIAgent {
  const getMindmapTopicsTool = new FunctionTool(
    async (_params) => JSON.stringify(scenario.mockMindmapTopics),
    'get_mindmap_topics',
    'Returns an array of topic label strings from the conversation mindmap.',
    { type: 'object', properties: {}, required: [] },
  );

  const getDueFlashcardsTool = new FunctionTool(
    async (_params) => JSON.stringify(scenario.mockDueCards),
    'get_due_flashcards',
    'Returns up to 10 flashcards due for review.',
    { type: 'object', properties: {}, required: [] },
  );

  return new OpenAIAgent(
    'flashcard-selection-agent',
    FLASHCARD_AGENT_INSTRUCTIONS,
    { tools: [getMindmapTopicsTool, getDueFlashcardsTool] },
  );
}

function parseSelectedId(content: string): number | null {
  try {
    const parsed = JSON.parse(content) as { id?: number | null };
    return parsed.id ?? null;
  } catch {
    const match = content.match(/"id"\s*:\s*(\d+)/);
    return match ? parseInt(match[1]!, 10) : null;
  }
}

async function main() {
  const judges = [new SelectionReasoningJudge(), new PriorityJudge(), new EdgeCaseJudge()];
  const results: EvalResult[] = [];

  for (const scenario of scenarios) {
    console.log(`\nRunning scenario: ${scenario.id}`);
    const agent = createEvalAgent(scenario);
    const response = await agent.run('Select a flashcard for review.');
    const agentResponse = response.messages.at(-1)?.content ?? '';
    console.log(`  Agent: ${agentResponse}`);

    const judgeScores = [];
    for (const judge of judges) {
      const s = await judge.judge(scenario, agentResponse);
      console.log(`  ${s.judgeName}: ${s.score}/10`);
      judgeScores.push(s);
    }

    const averageScore = judgeScores.reduce((sum, j) => sum + j.score, 0) / judgeScores.length;
    results.push({
      scenarioId: scenario.id,
      scenarioDescription: scenario.description,
      agentResponse,
      selectedCardId: parseSelectedId(agentResponse),
      judgeScores,
      averageScore,
    });
  }

  const html = renderReport(results);
  const outPath = path.join(__dirname, 'report.html');
  fs.writeFileSync(outPath, html);
  console.log(`\nReport written to ${outPath}`);
}

main().catch(console.error);
