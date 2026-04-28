import { Agent } from './agent';
import { OpenAIChatClient } from './client';
import { BaseTool } from './tool';
import { BaseMemory } from './memory';
import { AgentContext } from './context';
import { BaseMiddleware } from './middleware';

export interface OpenAIAgentOptions {
  model?: string;
  apiKey?: string;
  tools?: BaseTool[];
  memory?: BaseMemory;
  context?: AgentContext;
  middleware?: BaseMiddleware[];
  maxIterations?: number;
  streamTokens?: boolean;
}

export class OpenAIAgent extends Agent {
  constructor(name: string, instructions: string, options: OpenAIAgentOptions = {}) {
    const {
      model = 'gpt-4o-mini',
      apiKey,
      tools,
      memory,
      context,
      middleware,
      maxIterations,
      streamTokens = false,
    } = options;

    const client = new OpenAIChatClient(model, apiKey);
    super(name, instructions, client, tools, memory, context, middleware, maxIterations, streamTokens);
  }
}
