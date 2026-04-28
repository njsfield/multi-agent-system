import { ToolParameters, ToolSchema } from './types';

export abstract class BaseTool {
  name: string;
  description: string;

  constructor(name: string, description: string) {
    this.name = name;
    this.description = description;
  }

  abstract get parameters(): ToolParameters;
  abstract execute(parameters: Record<string, unknown>): unknown;

  toLLMFormat(): ToolSchema {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: this.parameters,
      },
    };
  }
}

export class FunctionTool extends BaseTool {
  private func: (params: Record<string, unknown>) => unknown;
  private schema: ToolParameters;

  constructor(
    func: (params: Record<string, unknown>) => unknown,
    name: string,
    description: string,
    schema: ToolParameters,
  ) {
    super(name, description);
    this.func = func;
    this.schema = schema;
  }

  get parameters(): ToolParameters {
    return this.schema;
  }

  execute(parameters: Record<string, unknown>): unknown {
    return this.func(parameters);
  }
}
