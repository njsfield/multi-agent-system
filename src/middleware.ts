import { AgentContext } from './context';

export interface MiddlewareContext {
  operation: 'model_call' | 'tool_call' | 'memory_access';
  agentName: string;
  agentContext: AgentContext;
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export abstract class BaseMiddleware {
  async processRequest(context: MiddlewareContext): Promise<MiddlewareContext> {
    return context;
  }

  async processResponse(context: MiddlewareContext, result: unknown): Promise<unknown> {
    return result;
  }

  async processError(_context: MiddlewareContext, error: Error): Promise<void> {
    throw error;
  }
}

export class LoggingMiddleware extends BaseMiddleware {
  async processRequest(context: MiddlewareContext): Promise<MiddlewareContext> {
    if (context.operation === 'tool_call') {
      const toolName = context.data['toolName'] ?? '?';
      const params = context.data['parameters'] as Record<string, unknown> ?? {};
      const paramStr = Object.entries(params).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');
      console.log(`  → tool: ${toolName}(${paramStr})`);
    } else {
      console.log(`[${context.agentName}] ${context.operation}`);
    }
    context.metadata['startTime'] = Date.now();
    return context;
  }

  async processResponse(context: MiddlewareContext, result: unknown): Promise<unknown> {
    const elapsed = ((Date.now() - (context.metadata['startTime'] as number ?? Date.now())) / 1000).toFixed(2);
    if (context.operation === 'tool_call') {
      console.log(`     done (${elapsed}s)`);
    }
    return result;
  }
}

export class MiddlewareChain {
  private middlewares: BaseMiddleware[];

  constructor(middlewares: BaseMiddleware[] = []) {
    this.middlewares = middlewares;
  }

  async execute(context: MiddlewareContext): Promise<MiddlewareContext> {
    for (const middleware of this.middlewares) {
      context = await middleware.processRequest(context);
    }
    return context;
  }

  async executeResponse(context: MiddlewareContext, result: unknown): Promise<unknown> {
    for (const middleware of this.middlewares) {
      result = await middleware.processResponse(context, result);
    }
    return result;
  }
}
