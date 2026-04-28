import OpenAI from 'openai';
import {
  Message,
  AssistantMessage,
  ToolMessage,
  ChatCompletionResult,
  ToolCallRequest,
  ToolSchema,
  TokenChunk,
  Usage,
} from './types';

function toOpenAITool(tool: ToolSchema): OpenAI.Chat.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: {
        type: tool.function.parameters.type,
        properties: tool.function.parameters.properties,
        required: tool.function.parameters.required,
      },
    },
  };
}

export abstract class BaseChatClient {
  abstract create(messages: Message[], tools?: ToolSchema[], signal?: AbortSignal): Promise<ChatCompletionResult>;

  // Default: fall back to non-streaming. Override in subclasses for real token streaming.
  async *createStream(messages: Message[], tools?: ToolSchema[], signal?: AbortSignal): AsyncGenerator<TokenChunk | ChatCompletionResult> {
    yield await this.create(messages, tools, signal);
  }
}

export class OpenAIChatClient extends BaseChatClient {
  readonly model: string;
  private client: OpenAI;

  constructor(model: string, apiKey?: string) {
    super();
    this.model = model;
    this.client = new OpenAI({
      apiKey: apiKey ?? process.env.OPENAI_API_KEY,
    });
  }

  async create(messages: Message[], tools?: ToolSchema[], signal?: AbortSignal): Promise<ChatCompletionResult> {
    const apiMessages = this.convertMessages(messages);

    const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      messages: apiMessages,
    };

    if (tools && tools.length > 0) {
      params.tools = tools.map(toOpenAITool);
    }

    const response = await this.client.chat.completions.create(params, { signal });
    const choice = response.choices[0];
    const msg = choice.message;

    let toolCalls: ToolCallRequest[] | undefined;
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      toolCalls = msg.tool_calls.map(tc => ({
        toolName: tc.function.name,
        parameters: JSON.parse(tc.function.arguments) as Record<string, unknown>,
        callId: tc.id,
      }));
    }

    const assistantMessage: AssistantMessage = {
      role: 'assistant',
      content: msg.content ?? '',
      source: 'assistant',
      timestamp: new Date(),
      toolCalls,
    };

    const usage: Usage = {
      tokens: response.usage?.prompt_tokens ?? 0,
      tokensOutput: response.usage?.completion_tokens ?? 0,
    };

    return {
      message: assistantMessage,
      usage,
      model: response.model,
      finishReason: choice.finish_reason ?? undefined,
    };
  }

  async *createStream(messages: Message[], tools?: ToolSchema[], signal?: AbortSignal): AsyncGenerator<TokenChunk | ChatCompletionResult> {
    const apiMessages = this.convertMessages(messages);

    const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model: this.model,
      messages: apiMessages,
      stream: true,
    };

    if (tools && tools.length > 0) {
      params.tools = tools.map(toOpenAITool);
    }

    const stream = await this.client.chat.completions.create(params, { signal });

    // Accumulators for assembling the full message from deltas
    let contentAccumulator = '';
    const toolCallAccumulator = new Map<number, { id: string; name: string; arguments: string }>();
    let finishReason: string | null = null;
    let responseModel = this.model;

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;

      responseModel = chunk.model ?? responseModel;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta;

      // Stream content tokens
      if (delta.content) {
        contentAccumulator += delta.content;
        const token: TokenChunk = {
          type: 'token',
          content: delta.content,
          source: 'assistant',
          timestamp: new Date(),
        };
        yield token;
      }

      // Accumulate tool call deltas (name + arguments arrive across multiple chunks)
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!toolCallAccumulator.has(tc.index)) {
            toolCallAccumulator.set(tc.index, { id: '', name: '', arguments: '' });
          }
          const entry = toolCallAccumulator.get(tc.index)!;
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (tc.function?.arguments) entry.arguments += tc.function.arguments;
        }
      }
    }

    // Build the final assembled result
    let toolCalls: ToolCallRequest[] | undefined;
    if (toolCallAccumulator.size > 0) {
      toolCalls = Array.from(toolCallAccumulator.values()).map(tc => ({
        toolName: tc.name,
        parameters: JSON.parse(tc.arguments || '{}') as Record<string, unknown>,
        callId: tc.id,
      }));
    }

    const assistantMessage: AssistantMessage = {
      role: 'assistant',
      content: contentAccumulator,
      source: 'assistant',
      timestamp: new Date(),
      toolCalls,
    };

    const result: ChatCompletionResult = {
      message: assistantMessage,
      model: responseModel,
      finishReason: finishReason ?? undefined,
    };

    yield result;
  }

  private convertMessages(messages: Message[]): OpenAI.Chat.ChatCompletionMessageParam[] {
    return messages.map(msg => {
      switch (msg.role) {
        case 'system':
          return { role: 'system' as const, content: msg.content };

        case 'user':
          return { role: 'user' as const, content: msg.content };

        case 'assistant': {
          const m = msg as AssistantMessage;
          if (m.toolCalls && m.toolCalls.length > 0) {
            return {
              role: 'assistant' as const,
              content: m.content || null,
              tool_calls: m.toolCalls.map(tc => ({
                id: tc.callId,
                type: 'function' as const,
                function: {
                  name: tc.toolName,
                  arguments: JSON.stringify(tc.parameters),
                },
              })),
            };
          }
          return { role: 'assistant' as const, content: m.content };
        }

        case 'tool': {
          const m = msg as ToolMessage;
          return {
            role: 'tool' as const,
            content: m.content,
            tool_call_id: m.toolCallId,
          };
        }
      }
    });
  }
}
