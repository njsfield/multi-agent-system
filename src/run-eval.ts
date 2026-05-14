import path from "path";
import { config } from "dotenv";

config({ path: path.join(__dirname, "../.env") });

const agentName = process.argv[2];

const agents: Record<string, string> = {
  FlashcardAgent: "./flashcard-agent.eval",
  "FlashcardAgent:extraction": "./flashcard-agent.eval",
  MindmapAgent: "./mindmap-agent.eval",
};

if (!agentName || !agents[agentName]) {
  console.error(`Usage: yarn eval <agent>`);
  console.error(`Available agents: ${Object.keys(agents).join(", ")}`);
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
require(agents[agentName]!);
