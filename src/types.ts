import type { FlashcardCard } from "./flashcard-service";

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
  createdAt: string;
}

export interface MindmapNode {
  id: string;
  type: "center" | "topic" | "fact";
  data: { label: string; color?: string };
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
  getFlashcard?: () => Promise<FlashcardCard | null>;
  reviewFlashcard?: (id: number, score: string) => Promise<Date>;
  getMindmap?: () => Promise<MindmapGraph>;
}
