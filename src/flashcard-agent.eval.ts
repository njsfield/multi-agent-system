import path from "path";
import { config } from "dotenv";
import { OpenAIAgent } from "./openai-agent";
import { FunctionTool } from "./tool";
import { SELECTION_INSTRUCTIONS, EXTRACTION_INSTRUCTIONS } from "./flashcard-agent";
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

// ---------------------------------------------------------------------------
// Extraction eval
// ---------------------------------------------------------------------------

interface ExtractionScenario {
  id: string;
  description: string;
  userMsg: string;
  assistantMsg: string;
  expectedBehavior: string;
  minCards: number;
  maxCards: number;
}

function createExtractionEvalAgent(): {
  agent: OpenAIAgent;
  getSavedCards: () => Array<{ question: string; answer: string }>;
} {
  const state = { savedCards: [] as Array<{ question: string; answer: string }> };

  const saveFlashcards = new FunctionTool(
    (params) => {
      const raw = params["flashcards"];
      if (!Array.isArray(raw)) {
        state.savedCards = [];
        return JSON.stringify({ saved: 0 });
      }
      state.savedCards = (raw as Array<{ question?: string; answer?: string }>)
        .filter((c) => c.question?.trim() && c.answer?.trim())
        .slice(0, 5)
        .map((c) => ({ question: c.question!.trim(), answer: c.answer!.trim() }));
      return JSON.stringify({ saved: state.savedCards.length });
    },
    "save_flashcards",
    "Save an array of flashcard {question, answer} pairs extracted from the exchange. Pass an empty array if no facts found.",
    {
      type: "object",
      properties: {
        flashcards: {
          type: "array",
          items: {
            type: "object",
            properties: {
              question: { type: "string" },
              answer: { type: "string" },
            },
            required: ["question", "answer"],
          },
        },
      },
      required: ["flashcards"],
    },
  );

  const agent = new OpenAIAgent("flashcard-extraction-eval", EXTRACTION_INSTRUCTIONS, {
    tools: [saveFlashcards],
    streamTokens: false,
  });

  return { agent, getSavedCards: () => state.savedCards };
}

// Count is validated inline via `inRange` in the run() output — no LLM judge needed.

class DistinctnessJudge extends LLMJudge {
  criteriaPrompt =
    "Evaluate whether all extracted flashcards cover genuinely different facts. Score 0 if any two cards are rephrasing of the same concept. Score 1 if all cards cover distinct, non-overlapping facts.";
}

class QualityJudge extends LLMJudge {
  criteriaPrompt =
    "Evaluate whether the flashcard questions are clear, specific, and independently answerable, and whether the answers are accurate, concise, and directly responsive to the question. Score 0 if any card has a vague question or an inaccurate/incomplete answer.";
}

const extractionScenarios: ExtractionScenario[] = [
  {
    id: "multi-fact-rich",
    description: "Rich compound interest explanation with 5+ distinct facts",
    userMsg: "Can you explain compound interest in detail?",
    assistantMsg: `Compound interest is interest calculated on both the initial principal and the accumulated interest from previous periods. The formula is A = P(1 + r/n)^(nt), where P is principal, r is annual interest rate, n is compounding frequency, and t is time in years. A useful shortcut is the Rule of 72: divide 72 by the annual interest rate to estimate how many years it takes for money to double. More frequent compounding (daily vs annually) yields slightly more growth. Compound interest differs from simple interest, which is calculated only on the principal.`,
    expectedBehavior: "Extracts >= 3 distinct flashcards covering the definition, formula, Rule of 72, compounding frequency, and/or the comparison to simple interest.",
    minCards: 3,
    maxCards: 5,
  },
  {
    id: "single-fact-simple",
    description: "Single clear fact — capital of France",
    userMsg: "What is the capital of France?",
    assistantMsg: "The capital of France is Paris.",
    expectedBehavior: "Extracts exactly 1 flashcard.",
    minCards: 1,
    maxCards: 1,
  },
  {
    id: "no-facts",
    description: "Casual exchange with no learnable facts",
    userMsg: "Thanks, that was really helpful!",
    assistantMsg: "You're welcome! Let me know if you have any other questions.",
    expectedBehavior: "Extracts 0 flashcards — no learnable fact present.",
    minCards: 0,
    maxCards: 0,
  },
  {
    id: "near-duplicate-facts",
    description: "Exchange that repeats the same fact in two phrasings",
    userMsg: "What does DNA stand for?",
    assistantMsg: "DNA stands for deoxyribonucleic acid. In other words, deoxyribonucleic acid is the molecule we call DNA.",
    expectedBehavior: "Extracts exactly 1 flashcard — the two phrasings are the same fact.",
    minCards: 1,
    maxCards: 1,
  },
  {
    id: "max-cap",
    description: "Extremely information-dense exchange touching 10+ facts",
    userMsg: "Tell me everything about the solar system.",
    assistantMsg: `The solar system formed about 4.6 billion years ago from a giant molecular cloud. The Sun contains 99.86% of the solar system's mass. There are 8 planets: Mercury, Venus, Earth, Mars, Jupiter, Saturn, Uranus, Neptune. The asteroid belt lies between Mars and Jupiter. Jupiter is the largest planet. Neptune is the farthest from the Sun. Earth is the only known planet with life. Mars has the tallest volcano, Olympus Mons. Saturn's rings are made mostly of ice and rock. Light from the Sun takes about 8 minutes to reach Earth.`,
    expectedBehavior: "Extracts exactly 5 flashcards (the maximum cap), despite more facts being available.",
    minCards: 5,
    maxCards: 5,
  },
];

async function mainExtraction() {
  await runEval({
    agentName: "FlashcardAgent:extraction",
    scenarios: extractionScenarios,
    judges: [
      new DistinctnessJudge(),
      new QualityJudge(),
    ],
    run: async (scenario) => {
      const { agent, getSavedCards } = createExtractionEvalAgent();
      await agent.run(
        `Extract flashcards from this exchange:\n\nUser: "${scenario.userMsg}"\nAssistant: "${scenario.assistantMsg}"`,
      );
      const cards = getSavedCards();
      const count = cards.length;
      const inRange = count >= scenario.minCards && count <= scenario.maxCards;
      return JSON.stringify({ count, inRange, cards });
    },
    buildContext: (scenario) =>
      `Scenario: ${scenario.description}\nExpected: ${scenario.expectedBehavior}\nExpected card count: [${scenario.minCards}, ${scenario.maxCards}]`,
    outputDir: __dirname,
  });
}

mainExtraction().catch(console.error);
