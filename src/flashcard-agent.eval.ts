import path from "path";
import { config } from "dotenv";
import { OpenAIAgent } from "./openai-agent";
import { FunctionTool } from "./tool";
import { SELECTION_INSTRUCTIONS } from "./flashcard-agent";
import { LLMJudge, runEval } from "./eval-utils";
import type { DueCard } from "./types";

config({ path: path.join(__dirname, "../.env") });

// ---------------------------------------------------------------------------
// Scenario definition
// ---------------------------------------------------------------------------

interface FlashcardScenario {
  id: string;
  description: string;
  expectedBehavior: string;
  mockDueCards: Omit<DueCard, "topicId">[];
}

// ---------------------------------------------------------------------------
// Eval agent factory — uses mock tools instead of a live DB
// ---------------------------------------------------------------------------

function createEvalAgent(scenario: FlashcardScenario): {
  agent: OpenAIAgent;
  getSelectedId: () => number | null;
} {
  const state = { selectedId: null as number | null };

  const getDueFlashcards = new FunctionTool(
    async () => JSON.stringify(scenario.mockDueCards),
    "get_due_flashcards",
    "Get flashcards due for review.",
    { type: "object", properties: {}, required: [] },
  );

  const selectCard = new FunctionTool(
    (params) => {
      const raw = params["id"];
      state.selectedId = raw != null && raw !== "null" ? Number(raw) : null;
      return JSON.stringify({ success: true });
    },
    "select_card",
    "Record the chosen flashcard ID. Pass id=null if no cards are available.",
    {
      type: "object",
      properties: { id: { description: "Flashcard ID or null" } },
      required: ["id"],
    },
  );

  const agent = new OpenAIAgent("flashcard-eval-agent", SELECTION_INSTRUCTIONS, {
    tools: [getDueFlashcards, selectCard],
    streamTokens: false,
  });

  return { agent, getSelectedId: () => state.selectedId };
}

// ---------------------------------------------------------------------------
// Judges
// ---------------------------------------------------------------------------

class PriorityJudge extends LLMJudge {
  criteriaPrompt =
    "Evaluate whether the agent selected the correct card per SM-2 priority: fail/hard+overdue > never reviewed > easy/very_easy; topic variety as tiebreaker. Score 0 if a clearly better card was ignored.";
}

class ReasoningJudge extends LLMJudge {
  criteriaPrompt =
    "Evaluate whether the agent clearly reasoned about WHY it selected the card, citing relevant factors like daysOverdue, lastScore, or topic variety.";
}

class EdgeCaseJudge extends LLMJudge {
  criteriaPrompt =
    "Evaluate correct handling of edge cases: returning select_card with id=null when no cards exist, and returning a valid integer id when cards are available. Score 0 for hallucinated ids.";
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const scenarios: FlashcardScenario[] = [
  {
    id: "overdue-fail",
    description: "Single card, 14 days overdue, last score = fail",
    mockDueCards: [
      { id: 1, question: "What is the capital of France?", topicLabel: "Geography", lastScore: "fail", daysOverdue: 14 },
    ],
    expectedBehavior: "Selects card id 1 — the only card, overdue and previously failed.",
  },
  {
    id: "topic-variety",
    description: "3 Geography cards + 1 History card, all equally due",
    mockDueCards: [
      { id: 2, question: "Capital of Germany?", topicLabel: "Geography", lastScore: "easy", daysOverdue: 0 },
      { id: 3, question: "Capital of Spain?",   topicLabel: "Geography", lastScore: "easy", daysOverdue: 0 },
      { id: 4, question: "Capital of Italy?",   topicLabel: "Geography", lastScore: "easy", daysOverdue: 0 },
      { id: 5, question: "When did WW2 end?",   topicLabel: "History",   lastScore: "easy", daysOverdue: 0 },
    ],
    expectedBehavior: "Selects card id 5 (History) to avoid a 4th Geography card in a row.",
  },
  {
    id: "no-cards",
    description: "get_due_flashcards returns an empty array",
    mockDueCards: [],
    expectedBehavior: 'Calls select_card with id=null — no cards, nothing to hallucinate.',
  },
  {
    id: "fail-vs-easy",
    description: "Two equally overdue cards — one previously fail, one previously easy",
    mockDueCards: [
      { id: 6, question: "What causes thunder?",         topicLabel: "Weather", lastScore: "fail", daysOverdue: 3 },
      { id: 7, question: "What is the Coriolis effect?", topicLabel: "Weather", lastScore: "easy", daysOverdue: 3 },
    ],
    expectedBehavior: "Selects card id 6 (lastScore=fail) over card id 7 (lastScore=easy).",
  },
  {
    id: "never-reviewed",
    description: "One never-reviewed card, no overdue cards",
    mockDueCards: [
      { id: 8, question: "Who was Napoleon Bonaparte?", topicLabel: "History", lastScore: null, daysOverdue: 0 },
    ],
    expectedBehavior: "Selects card id 8 — never-reviewed cards should be prioritised.",
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await runEval({
    agentName: "FlashcardAgent",
    scenarios,
    judges: [new PriorityJudge(), new ReasoningJudge(), new EdgeCaseJudge()],
    run: async (scenario) => {
      const { agent } = createEvalAgent(scenario);
      const response = await agent.run("Select a flashcard for review.");
      return response.messages.at(-1)?.content ?? "";
    },
    buildContext: (scenario) =>
      `Scenario: ${scenario.description}\nExpected: ${scenario.expectedBehavior}\nAvailable cards: ${JSON.stringify(scenario.mockDueCards)}`,
    outputDir: __dirname,
  });
}

main().catch(console.error);
