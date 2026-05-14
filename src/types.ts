import type { FlashcardAgent } from "./flashcard-agent";

export interface ToolCallRequest {
  toolName: string;
  parameters: Record<string, unknown>;
  callId: string;
}

export interface BaseMessage {
  content: string;
  source: string;
  timestamp: Date;
}

export interface SystemMessage extends BaseMessage {
  role: "system";
}

export interface UserMessage extends BaseMessage {
  role: "user";
  name?: string;
}

export interface AssistantMessage extends BaseMessage {
  role: "assistant";
  toolCalls?: ToolCallRequest[];
}

export interface ToolMessage extends BaseMessage {
  role: "tool";
  toolCallId: string;
  toolName: string;
  success: boolean;
  error?: string;
  requiresApproval?: boolean;
}

export type Message =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage;

export interface Usage {
  tokens: number;
  tokensOutput: number;
}

export interface ChatCompletionResult {
  message: AssistantMessage;
  structuredOutput?: unknown;
  usage?: Usage;
  model?: string;
  finishReason?: string;
}

export interface AgentResponse {
  messages: Message[];
}

export interface AgentEvent {
  type: string;
  data?: unknown;
}

export interface TokenChunk {
  type: "token";
  content: string;
  source: string;
  timestamp: Date;
}

export interface ToolParameters {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: ToolParameters;
  };
}

export interface HistoryMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  source: string;
  contentType: "text" | "markdown";
  topicId?: number | null;
  subtopic?: string | null;
  createdAt: string;
}

export interface DueCard {
  id: number;
  question: string;
  topicId: number | null;
  topicLabel: string | null;
  lastScore: string | null;
  daysOverdue: number;
}

export interface FlashcardCard {
  id: number;
  question: string;
  answer: string;
  topicId: number | null;
  topicLabel: string | null;
  subtopic: string | null;
}

export interface TopicTree {
  id: number;
  label: string;
  subtopics: string[];
}

export interface FlashcardFilter {
  topicIds?: number[];
  subtopics?: Array<{ topicId: number; subtopic: string }>;
}

export interface MindmapNode {
  id: string;
  type: "center" | "topic" | "subtopic" | "fact";
  data: { label: string; color?: string; topicId?: number; subtopic?: string; topicLabel?: string };
}

export interface MindmapEdge {
  id: string;
  source: string;
  target: string;
}

export interface MindmapGraph {
  nodes: MindmapNode[];
  edges: MindmapEdge[];
  updatedAt?: string;
}

export interface AgentServerOptions {
  staticDir?: string;
  getHistory?: (limit: number) => Promise<HistoryMessage[]>;
  flashcardAgent?: FlashcardAgent;
  getMindmap?: () => Promise<MindmapGraph>;
  getTopics?: () => Promise<TopicTree[]>;
}
