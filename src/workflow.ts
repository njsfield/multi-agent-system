export enum StepStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export interface StepResult {
  stepId: string;
  input: unknown;
  output: unknown;
  status: StepStatus;
  error?: string;
}

export abstract class BaseStep<TInput = unknown, TOutput = unknown> {
  stepId: string;
  private _status: StepStatus = StepStatus.PENDING;

  constructor(stepId?: string) {
    this.stepId = stepId ?? this.constructor.name;
  }

  get status(): StepStatus {
    return this._status;
  }

  abstract execute(input: TInput): TOutput;

  run(input: TInput): TOutput {
    this._status = StepStatus.RUNNING;
    try {
      const output = this.execute(input);
      this._status = StepStatus.COMPLETED;
      return output;
    } catch (e) {
      this._status = StepStatus.FAILED;
      throw e;
    }
  }
}

export class FunctionStep<TInput = unknown, TOutput = unknown> extends BaseStep<TInput, TOutput> {
  private func: (input: TInput) => TOutput;

  constructor(func: (input: TInput) => TOutput, stepId?: string) {
    super(stepId ?? func.name);
    this.func = func;
  }

  execute(input: TInput): TOutput {
    return this.func(input);
  }
}

export type EdgeConditionType = 'always' | 'on_success' | 'on_failure';

export interface EdgeCondition {
  type: EdgeConditionType;
}

export interface Edge {
  id: string;
  fromStep: string;
  toStep: string;
  condition: EdgeCondition;
}

export interface WorkflowConfiguration {
  value?: unknown;
}

export class Workflow {
  name: string;
  private steps: Map<string, BaseStep> = new Map();
  private edges: Edge[] = [];

  constructor(name: string) {
    this.name = name;
  }

  addStep(step: BaseStep): this {
    this.steps.set(step.stepId, step);
    return this;
  }

  addEdge(
    fromStep: string | string[],
    toStep: string | string[],
    condition: EdgeCondition = { type: 'always' },
  ): this {
    const sources = Array.isArray(fromStep) ? fromStep : [fromStep];
    const targets = Array.isArray(toStep) ? toStep : [toStep];
    for (const src of sources) {
      for (const tgt of targets) {
        this.edges.push({
          id: `${src}->${tgt}-${Math.random().toString(36).slice(2)}`,
          fromStep: src,
          toStep: tgt,
          condition,
        });
      }
    }
    return this;
  }

  chain(...steps: BaseStep[]): this {
    for (const step of steps) this.addStep(step);
    for (let i = 0; i < steps.length - 1; i++) {
      this.addEdge(steps[i].stepId, steps[i + 1].stepId);
    }
    return this;
  }

  getStep(stepId: string): BaseStep | undefined {
    return this.steps.get(stepId);
  }

  getStepIds(): string[] {
    return [...this.steps.keys()];
  }

  startSteps(): string[] {
    const withIncoming = new Set(this.edges.map(e => e.toStep));
    return [...this.steps.keys()].filter(id => !withIncoming.has(id));
  }

  predecessors(stepId: string): string[] {
    return this.edges.filter(e => e.toStep === stepId).map(e => e.fromStep);
  }

  nextSteps(fromStep: string, status: StepStatus): string[] {
    return this.edges
      .filter(e => e.fromStep === fromStep && this.evalCondition(e.condition, status))
      .map(e => e.toStep);
  }

  outgoingSteps(fromStep: string): string[] {
    return this.edges.filter(e => e.fromStep === fromStep).map(e => e.toStep);
  }

  private evalCondition(condition: EdgeCondition, status: StepStatus): boolean {
    switch (condition.type) {
      case 'always': return true;
      case 'on_success': return status === StepStatus.COMPLETED;
      case 'on_failure': return status === StepStatus.FAILED;
    }
  }
}

export class WorkflowRunner {
  *runStream(workflow: Workflow, config: WorkflowConfiguration = {}): Generator<StepResult> {
    const received = new Map<string, Map<string, unknown>>();
    const completed = new Set<string>();

    let pending: Array<[string, unknown]> = workflow.startSteps().map(id => [id, config.value]);

    while (pending.length > 0) {
      const batchResults: StepResult[] = [];

      for (const [stepId, inputVal] of pending) {
        const step = workflow.getStep(stepId);
        if (!step) continue;
        try {
          const output = step.run(inputVal as never);
          batchResults.push({ stepId, input: inputVal, output, status: StepStatus.COMPLETED });
        } catch (e) {
          batchResults.push({
            stepId,
            input: inputVal,
            output: undefined,
            status: StepStatus.FAILED,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      for (const result of batchResults) {
        yield result;
        completed.add(result.stepId);

        const firedTo = new Set(workflow.nextSteps(result.stepId, result.status));
        for (const nextId of firedTo) {
          if (!received.has(nextId)) received.set(nextId, new Map());
          received.get(nextId)!.set(result.stepId, result.output);
        }
        // Steps with edges that didn't fire get a null contribution (opted-out)
        for (const allNext of workflow.outgoingSteps(result.stepId)) {
          if (!firedTo.has(allNext)) {
            if (!received.has(allNext)) received.set(allNext, new Map());
            received.get(allNext)!.set(result.stepId, null);
          }
        }
      }

      pending = [];
      for (const stepId of workflow.getStepIds()) {
        if (completed.has(stepId)) continue;
        const preds = workflow.predecessors(stepId);
        if (!preds.length) continue;
        const stepReceived = received.get(stepId);
        if (!stepReceived) continue;
        if (preds.some(p => !stepReceived.has(p))) continue;

        // Fan-in: collect non-null contributions
        const contributions = preds
          .map(p => stepReceived.get(p))
          .filter(v => v !== null && v !== undefined);
        if (!contributions.length) continue;

        const inputVal = contributions.length === 1 ? contributions[0] : contributions;
        pending.push([stepId, inputVal]);
      }
    }
  }

  run(workflow: Workflow, config: WorkflowConfiguration = {}): unknown {
    let last: StepResult | undefined;
    for (const result of this.runStream(workflow, config)) {
      last = result;
    }
    return last?.output ?? config.value;
  }
}
