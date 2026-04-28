import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import { OpenAIAgent } from "../src/openai-agent";
import {
  PlanBasedOrchestrator,
  MaxMessageTermination,
  TextMentionTermination,
  OrTermination,
  OrchestrationResult,
} from "../src/orchestrator";
import { OpenAIChatClient } from "../src/client";
import { FunctionTool } from "../src/tool";
import { LoggingMiddleware } from "../src/middleware";
import { OtelMiddleware } from "../src/otel-middleware";
import { MarkdownMiddleware } from "../src/markdown-middleware";
import { Message } from "../src/types";

const otelMiddleware = new OtelMiddleware();

// ---------------------------------------------------------------------------
// Load .env from exercises directory
// ---------------------------------------------------------------------------

try {
  const envPath = path.join(__dirname, "../../exercises/.env");
  const raw = fs.readFileSync(envPath, "utf-8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const val = trimmed.slice(eqIndex + 1).trim();
    if (key && !process.env[key]) process.env[key] = val;
  }
} catch {
  // no .env found — rely on environment variables already set
}

// ---------------------------------------------------------------------------
// ANSI colours
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const MAGENTA = "\x1b[35m";
const BLUE = "\x1b[34m";
const RED = "\x1b[31m";

const AGENT_COLORS: Record<string, string> = {
  researcher: CYAN,
  writer: GREEN,
  critic: MAGENTA,
};

function agentColor(name: string): string {
  return AGENT_COLORS[name.toLowerCase()] ?? BLUE;
}

function printBanner(): void {
  console.log();
  console.log(
    `${BOLD}${BLUE}╔══════════════════════════════════════════════════╗${RESET}`,
  );
  console.log(
    `${BOLD}${BLUE}║       Plan-Based Multi-Agent Orchestration        ║${RESET}`,
  );
  console.log(
    `${BOLD}${BLUE}╚══════════════════════════════════════════════════╝${RESET}`,
  );
  console.log();
  console.log(
    `${DIM}Agents: ${CYAN}Researcher${RESET}${DIM}, ${GREEN}Writer${RESET}${DIM}, ${MAGENTA}Critic${RESET}`,
  );
  console.log(
    `${DIM}The orchestrator creates a plan, assigns each step to an agent,`,
  );
  console.log(`and retries failed steps automatically.${RESET}`);
  console.log();
}

function printSeparator(): void {
  console.log(
    `${DIM}──────────────────────────────────────────────────${RESET}`,
  );
}

function printMessage(msg: Message): void {
  const color = agentColor(msg.source);
  console.log();
  console.log(`${BOLD}${color}[${msg.source}]${RESET}`);
  for (const line of msg.content.split("\n")) {
    console.log(`  ${line}`);
  }
}

// ---------------------------------------------------------------------------
// Tools — each returns a string instruction the agent uses as guidance
// ---------------------------------------------------------------------------

const researchTool = new FunctionTool(
  (params) => `Use wikipedia.org to research: ${params["query"]}`,
  "search_web",
  "Search the web for information on a topic. Returns research guidance.",
  {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The topic or question to research",
      },
    },
    required: ["query"],
  },
);

const writeTool = new FunctionTool(
  (params) =>
    `Write a ${params["format"] ?? "short article"} about: ${params["topic"]}. ` +
    `Use clear headings, engaging language, and a logical structure.`,
  "write_content",
  "Write content on a topic in a given format.",
  {
    type: "object",
    properties: {
      topic: { type: "string", description: "Topic to write about" },
      format: {
        type: "string",
        description: "Format: article, essay, report, summary, etc.",
      },
    },
    required: ["topic"],
  },
);

const reviewTool = new FunctionTool(
  (params) =>
    `Review the following content and give specific feedback on accuracy, clarity, ` +
    `structure, and engagement. Focus: ${params["focus"] ?? "overall quality"}.\n\n` +
    `Content:\n${params["content"]}`,
  "review_content",
  "Review content and provide constructive criticism.",
  {
    type: "object",
    properties: {
      content: { type: "string", description: "The content to review" },
      focus: {
        type: "string",
        description: "Specific aspect to focus on (optional)",
      },
    },
    required: ["content"],
  },
);

// ---------------------------------------------------------------------------
// Agent definitions
// ---------------------------------------------------------------------------

function createAgents() {
  const middleware = [
    new LoggingMiddleware(),
    otelMiddleware,
    new MarkdownMiddleware(),
  ];

  const researcher = new OpenAIAgent(
    "researcher",
    `You are a skilled researcher. When given a topic, use your search_web tool to get
research guidance, then provide accurate, well-organized findings. Include key facts,
context, and relevant details. Be concise but thorough.`,
    { tools: [researchTool], middleware },
  );

  const writer = new OpenAIAgent(
    "writer",
    `You are a creative writer. Use your write_content tool to get writing guidance,
then craft engaging, well-structured content based on the research provided. Focus on
clarity, flow, and making the content compelling for a general audience.`,
    { tools: [writeTool], middleware },
  );

  const critic = new OpenAIAgent(
    "critic",
    `You are a constructive critic. Use your review_content tool to structure your review,
then give specific, actionable feedback on accuracy, clarity, structure, and engagement.
Highlight what works well and what needs improvement.`,
    { tools: [reviewTool], middleware },
  );

  return { researcher, writer, critic };
}

// ---------------------------------------------------------------------------
// Run orchestration for a single task
// ---------------------------------------------------------------------------

async function runTask(task: string): Promise<void> {
  console.log();
  printSeparator();
  console.log(`${BOLD}Task:${RESET} ${task}`);
  printSeparator();

  const { researcher, writer, critic } = createAgents();
  const plannerClient = new OpenAIChatClient("gpt-4o-mini");

  const termination = new OrTermination(
    new MaxMessageTermination(20),
    new TextMentionTermination("DONE"),
  );

  const orchestrator = new PlanBasedOrchestrator(
    [researcher, writer, critic],
    termination,
    plannerClient,
    20,
    /* maxStepRetries */ 1,
  );

  console.log(`\n${DIM}Creating plan...${RESET}`);

  let messageCount = 0;

  for await (const item of orchestrator.runStream(task)) {
    if ("finalResult" in item) {
      const result = item as OrchestrationResult;
      console.log();
      printSeparator();
      console.log(
        `${BOLD}${GREEN}Done${RESET} — ${result.iterationsCompleted} step(s), ${messageCount} message(s)`,
      );
      printSeparator();
    } else {
      const msg = item as Message;
      if (msg.role === "user") continue;
      messageCount++;
      printMessage(msg);
    }
  }

  console.log();
}

// ---------------------------------------------------------------------------
// CLI input loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  printBanner();

  otelMiddleware.setupOtelProviders();

  if (!process.env.OPENAI_API_KEY) {
    console.error(`${RED}Error: OPENAI_API_KEY is not set.${RESET}`);
    console.error(`Set it in your environment or add it to exercises/.env`);
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  console.log(
    `Type a task and press Enter. Type ${BOLD}exit${RESET} to quit.\n`,
  );

  while (true) {
    const input = (await ask(`${BOLD}${BLUE}> ${RESET}`)).trim();
    if (!input) continue;
    if (input.toLowerCase() === "exit" || input.toLowerCase() === "quit") {
      console.log(`\n${DIM}Goodbye.${RESET}\n`);
      rl.close();
      break;
    }

    try {
      await runTask(input);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n${RED}Error: ${msg}${RESET}\n`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
