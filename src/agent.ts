import { BaseChatClient } from "./client";
import { BaseTool } from "./tool";
import { BaseMemory } from "./memory";
import { AgentContext } from "./context";
import {
  BaseMiddleware,
  MiddlewareChain,
  MiddlewareContext,
} from "./middleware";
import {
  Message,
  SystemMessage,
  UserMessage,
  ToolMessage,
  AgentResponse,
  AgentEvent,
  ToolSchema,
  ToolCallRequest,
  ToolParameters,
  TokenChunk,
  ChatCompletionResult,
} from "./types";

export abstract class BaseAgent {
  name: string;
  instructions: string;
  protected modelClient: BaseChatClient;
  protected tools: BaseTool[];
  protected memory?: BaseMemory;
  protected context: AgentContext;
  protected middlewareChain: MiddlewareChain;
  protected maxIterations: number;
  protected streamTokens: boolean;

  constructor(
    name: string,
    instructions: string,
    modelClient: BaseChatClient,
    tools: BaseTool[] = [],
    memory?: BaseMemory,
    context?: AgentContext,
    middleware: BaseMiddleware[] = [],
    maxIterations = 10,
    streamTokens = false,
  ) {
    this.name = name;
    this.instructions = instructions;
    this.modelClient = modelClient;
    this.tools = tools;
    this.memory = memory;
    this.context = context ?? new AgentContext();
    this.middlewareChain = new MiddlewareChain(middleware);
    this.maxIterations = maxIterations;
    this.streamTokens = streamTokens;
  }

  abstract run(task: string | UserMessage | Message[]): Promise<AgentResponse>;
  abstract runStream(
    task: string | UserMessage | Message[],
    signal?: AbortSignal,
  ): AsyncGenerator<Message | AgentEvent | TokenChunk>;

  protected normalizeTask(task: string | UserMessage | Message[]): Message[] {
    if (typeof task === "string") {
      return [
        { role: "user", content: task, source: "user", timestamp: new Date() },
      ];
    }
    if (!Array.isArray(task)) return [task];
    return task;
  }

  protected getToolsForLLM(): ToolSchema[] | undefined {
    if (!this.tools.length) return undefined;
    return this.tools.map((t) => t.toLLMFormat());
  }
}

export class Agent extends BaseAgent {
  async run(task: string | UserMessage | Message[]): Promise<AgentResponse> {
    const taskMessages = this.normalizeTask(task);
    const userContent =
      taskMessages.find((m) => m.role === "user")?.content ?? "";

    let instructions = this.instructions;
    if (this.memory) {
      const [recentCtx, relevantCtx] = await Promise.all([
        this.memory.getContext(20),
        this.memory.query(userContent, 5),
      ]);
      if (recentCtx.length)
        instructions += `\n\nRecent conversation:\n${recentCtx.join("\n")}`;
      if (relevantCtx.length)
        instructions += `\n\nRelevant past context:\n${relevantCtx.join("\n")}`;
    }

    const systemMessage: SystemMessage = {
      role: "system",
      content: instructions,
      source: "system",
      timestamp: new Date(),
    };
    const llmMessages: Message[] = [
      systemMessage,
      ...this.context.messages,
      ...taskMessages,
    ];
    const tools = this.getToolsForLLM();
    const responses: Message[] = [];

    for (let i = 0; i < this.maxIterations; i++) {
      const modelCtx = this.buildModelCtx(llmMessages);
      await this.middlewareChain.execute(modelCtx);
      let completionResult = await this.modelClient.create(llmMessages, tools);
      completionResult =
        ((await this.middlewareChain.executeResponse(
          modelCtx,
          completionResult,
        )) as typeof completionResult) ?? completionResult;

      const assistantMessage = completionResult.message;
      llmMessages.push(assistantMessage);

      if (!assistantMessage.toolCalls?.length) {
        this.context.addMessage(assistantMessage);
        responses.push(assistantMessage);

        if (this.memory) {
          await this.memory.add(userContent, { role: "user", source: "user" });
          await this.memory.add(assistantMessage.content, {
            role: "assistant",
            source: this.name,
          });
        }
        break;
      }

      for (const toolCall of assistantMessage.toolCalls) {
        llmMessages.push(await this.runToolCall(toolCall));
      }
    }

    return { messages: responses };
  }

  async *runStream(
    task: string | UserMessage | Message[],
    signal?: AbortSignal,
  ): AsyncGenerator<Message | AgentEvent | TokenChunk> {
    const taskMessages = this.normalizeTask(task);
    const userContent =
      taskMessages.find((m) => m.role === "user")?.content ?? "";

    let instructions = this.instructions;
    if (this.memory) {
      const [recentCtx, relevantCtx] = await Promise.all([
        this.memory.getContext(20),
        this.memory.query(userContent, 5),
      ]);
      if (recentCtx.length)
        instructions += `\n\nRecent conversation:\n${recentCtx.join("\n")}`;
      if (relevantCtx.length)
        instructions += `\n\nRelevant past context:\n${relevantCtx.join("\n")}`;
    }

    const systemMessage: SystemMessage = {
      role: "system",
      content: instructions,
      source: "system",
      timestamp: new Date(),
    };
    const llmMessages: Message[] = [
      systemMessage,
      ...this.context.messages,
      ...taskMessages,
    ];
    const tools = this.getToolsForLLM();

    for (let i = 0; i < this.maxIterations; i++) {
      signal?.throwIfAborted();

      const modelCtx = this.buildModelCtx(llmMessages);
      await this.middlewareChain.execute(modelCtx);

      let completionResult: ChatCompletionResult;

      if (this.streamTokens) {
        let finalResult: ChatCompletionResult | undefined;

        for await (const item of this.modelClient.createStream(
          llmMessages,
          tools,
          signal,
        )) {
          if ((item as TokenChunk).type === "token") {
            yield item as TokenChunk;
          } else {
            finalResult = item as ChatCompletionResult;
          }
        }

        if (!finalResult) break;
        completionResult =
          ((await this.middlewareChain.executeResponse(
            modelCtx,
            finalResult,
          )) as ChatCompletionResult) ?? finalResult;
      } else {
        let result = await this.modelClient.create(llmMessages, tools, signal);
        completionResult =
          ((await this.middlewareChain.executeResponse(
            modelCtx,
            result,
          )) as typeof result) ?? result;
      }

      const assistantMessage = completionResult.message;
      const taggedMessage: Message = { ...assistantMessage, source: this.name };
      llmMessages.push(taggedMessage);

      if (!assistantMessage.toolCalls?.length) {
        this.context.addMessage(taggedMessage);
        yield taggedMessage;

        if (this.memory) {
          await this.memory.add(userContent, { role: "user", source: "user" });
          await this.memory.add(assistantMessage.content, {
            role: "assistant",
            source: this.name,
          });
        }
        break;
      }

      for (const toolCall of assistantMessage.toolCalls) {
        llmMessages.push(await this.runToolCall(toolCall));
      }
    }
  }

  asTool(resultStrategy: "last:1" | "all" = "last:1"): AgentTool {
    return new AgentTool(this, resultStrategy);
  }

  private buildModelCtx(llmMessages: Message[]): MiddlewareContext {
    return {
      operation: "model_call",
      agentName: this.name,
      agentContext: this.context,
      data: {
        model:
          (this.modelClient as unknown as { model?: string }).model ??
          "unknown",
        messages: llmMessages,
        input: llmMessages[llmMessages.length - 1]?.content ?? "",
      },
      metadata: {},
    };
  }

  private async runToolCall(toolCall: ToolCallRequest): Promise<ToolMessage> {
    const toolCtx: MiddlewareContext = {
      operation: "tool_call",
      agentName: this.name,
      agentContext: this.context,
      data: {
        toolName: toolCall.toolName,
        callId: toolCall.callId,
        parameters: toolCall.parameters,
        input: JSON.stringify(toolCall.parameters),
      },
      metadata: {},
    };
    await this.middlewareChain.execute(toolCtx);
    let toolResult = await this.executeToolCall(toolCall);
    toolResult =
      ((await this.middlewareChain.executeResponse(
        toolCtx,
        toolResult,
      )) as typeof toolResult) ?? toolResult;
    return toolResult;
  }

  private async executeToolCall(
    toolCall: ToolCallRequest,
  ): Promise<ToolMessage> {
    const tool = this.tools.find((t) => t.name === toolCall.toolName);
    if (!tool) {
      return {
        role: "tool",
        content: `Error: Tool '${toolCall.toolName}' not found.`,
        toolCallId: toolCall.callId,
        toolName: toolCall.toolName,
        source: this.name,
        timestamp: new Date(),
        success: false,
        error: "Tool not found",
      };
    }

    try {
      let result = tool.execute(toolCall.parameters);
      if (result instanceof Promise) result = await result;
      return {
        role: "tool",
        content: String(result),
        toolCallId: toolCall.callId,
        toolName: toolCall.toolName,
        source: this.name,
        timestamp: new Date(),
        success: true,
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return {
        role: "tool",
        content: `Error executing tool '${toolCall.toolName}': ${error}`,
        toolCallId: toolCall.callId,
        toolName: toolCall.toolName,
        source: this.name,
        timestamp: new Date(),
        success: false,
        error,
      };
    }
  }
}

export class AgentTool extends BaseTool {
  private agent: Agent;
  private resultStrategy: "last:1" | "all";

  constructor(agent: Agent, resultStrategy: "last:1" | "all" = "last:1") {
    super(agent.name, agent.instructions);
    this.agent = agent;
    this.resultStrategy = resultStrategy;
  }

  get parameters(): ToolParameters {
    return {
      type: "object",
      properties: {
        task: { type: "string", description: "The task to give the agent." },
      },
      required: ["task"],
    };
  }

  async execute(parameters: Record<string, unknown>): Promise<string> {
    const task = String(parameters["task"] ?? "");
    const response = await this.agent.run(task);
    return this.applyStrategy(response.messages);
  }

  private applyStrategy(messages: Message[]): string {
    if (!messages.length) return "";
    if (this.resultStrategy === "all") {
      return messages.map((m) => m.content).join("\n");
    }
    const n = parseInt(this.resultStrategy.split(":")[1] ?? "1", 10);
    return messages
      .slice(-n)
      .map((m) => m.content)
      .join("\n");
  }
}
