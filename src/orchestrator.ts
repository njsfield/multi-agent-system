import { BaseAgent } from './agent';
import { BaseChatClient } from './client';
import { Message, UserMessage, AgentResponse } from './types';

// ---------------------------------------------------------------------------
// Termination conditions
// ---------------------------------------------------------------------------

export interface TerminationCondition {
  check(messages: Message[]): boolean;
  reset(): void;
}

export class MaxMessageTermination implements TerminationCondition {
  private maxMessages: number;
  private count = 0;

  constructor(maxMessages: number) {
    this.maxMessages = maxMessages;
  }

  check(messages: Message[]): boolean {
    this.count += messages.length;
    return this.count >= this.maxMessages;
  }

  reset(): void {
    this.count = 0;
  }
}

export class TextMentionTermination implements TerminationCondition {
  private text: string;
  private met = false;

  constructor(text: string) {
    this.text = text;
  }

  check(messages: Message[]): boolean {
    if (!this.met) {
      this.met = messages.some(m => m.content.includes(this.text));
    }
    return this.met;
  }

  reset(): void {
    this.met = false;
  }
}

export class OrTermination implements TerminationCondition {
  private conditions: TerminationCondition[];

  constructor(...conditions: TerminationCondition[]) {
    this.conditions = conditions;
  }

  check(messages: Message[]): boolean {
    return this.conditions.some(c => c.check(messages));
  }

  reset(): void {
    this.conditions.forEach(c => c.reset());
  }
}

// ---------------------------------------------------------------------------
// Orchestration result
// ---------------------------------------------------------------------------

export interface OrchestrationResult {
  messages: Message[];
  finalResult: string;
  iterationsCompleted: number;
}

// ---------------------------------------------------------------------------
// Base orchestrator
// ---------------------------------------------------------------------------

export abstract class BaseOrchestrator {
  protected agents: BaseAgent[];
  protected termination: TerminationCondition;
  protected maxIterations: number;
  protected sharedMessages: Message[] = [];
  protected iterationCount = 0;

  constructor(
    agents: BaseAgent[],
    termination: TerminationCondition,
    maxIterations = 50,
  ) {
    if (!agents.length) throw new Error('At least one agent is required');
    const names = agents.map(a => a.name);
    if (names.length !== new Set(names).size) throw new Error('Agent names must be unique');
    this.agents = agents;
    this.termination = termination;
    this.maxIterations = maxIterations;
  }

  async run(task: string | UserMessage | Message[]): Promise<OrchestrationResult> {
    this.reset();
    const initial = this.normalizeTask(task);
    this.sharedMessages.push(...initial);

    if (this.termination.check(initial)) {
      return this.buildResult();
    }

    while (this.iterationCount < this.maxIterations) {
      const agent = await this.selectNextAgent();
      const context = await this.prepareContext(agent);
      const result = await agent.run(context);
      await this.updateSharedState(result);
      if (this.termination.check(result.messages)) break;
      this.iterationCount++;
    }

    return this.buildResult();
  }

  async *runStream(
    task: string | UserMessage | Message[],
  ): AsyncGenerator<Message | OrchestrationResult> {
    this.reset();
    const initial = this.normalizeTask(task);
    this.sharedMessages.push(...initial);
    for (const msg of initial) yield msg;

    if (this.termination.check(initial)) {
      yield this.buildResult();
      return;
    }

    while (this.iterationCount < this.maxIterations) {
      const agent = await this.selectNextAgent();
      const context = await this.prepareContext(agent);
      const result = await agent.run(context);

      for (const msg of result.messages) {
        if (msg.role !== 'user') yield msg;
      }

      await this.updateSharedState(result);
      if (this.termination.check(result.messages)) break;
      this.iterationCount++;
    }

    yield this.buildResult();
  }

  protected abstract selectNextAgent(): Promise<BaseAgent>;
  protected abstract prepareContext(agent: BaseAgent): Promise<string | UserMessage | Message[]>;
  protected abstract updateSharedState(result: AgentResponse): Promise<void>;

  protected normalizeTask(task: string | UserMessage | Message[]): Message[] {
    if (typeof task === 'string') {
      return [{ role: 'user', content: task, source: 'user', timestamp: new Date() }];
    }
    if (!Array.isArray(task)) return [task];
    return task;
  }

  protected getAgentCapabilitiesSummary(): string {
    return this.agents.map(a => `- ${a.name}: ${a.instructions}`).join('\n');
  }

  protected reset(): void {
    this.sharedMessages = [];
    this.iterationCount = 0;
    this.termination.reset();
  }

  private buildResult(): OrchestrationResult {
    let finalResult = 'Task completed';
    for (let i = this.sharedMessages.length - 1; i >= 0; i--) {
      if (this.sharedMessages[i].role === 'assistant') {
        finalResult = this.sharedMessages[i].content;
        break;
      }
    }
    return { messages: this.sharedMessages, finalResult, iterationsCompleted: this.iterationCount };
  }
}

// ---------------------------------------------------------------------------
// Round-robin orchestrator
// ---------------------------------------------------------------------------

export class RoundRobinOrchestrator extends BaseOrchestrator {
  private currentAgentIndex = 0;

  protected async selectNextAgent(): Promise<BaseAgent> {
    const agent = this.agents[this.currentAgentIndex];
    this.currentAgentIndex = (this.currentAgentIndex + 1) % this.agents.length;
    return agent;
  }

  protected async prepareContext(_agent: BaseAgent): Promise<string> {
    if (!this.sharedMessages.length) {
      return 'You are part of a team taking turns to collaboratively address a task. It is now your turn.';
    }
    const history = this.sharedMessages.map(m => `[${m.source}]: ${m.content}`).join('\n');
    return `You are part of a team taking turns to collaboratively address a task. Here's the progress so far:\n\n${history}\n\nIt is now your turn.`;
  }

  protected async updateSharedState(result: AgentResponse): Promise<void> {
    this.sharedMessages.push(...result.messages);
  }

  protected reset(): void {
    super.reset();
    this.currentAgentIndex = 0;
  }
}

// ---------------------------------------------------------------------------
// AI-driven orchestrator
// ---------------------------------------------------------------------------

interface AgentSelection {
  selected_agent: string;
  reasoning: string;
}

export class AIOrchestrator extends BaseOrchestrator {
  private modelClient: BaseChatClient;

  constructor(
    agents: BaseAgent[],
    termination: TerminationCondition,
    modelClient: BaseChatClient,
    maxIterations = 50,
  ) {
    super(agents, termination, maxIterations);
    this.modelClient = modelClient;
  }

  protected async selectNextAgent(): Promise<BaseAgent> {
    const capabilities = this.getAgentCapabilitiesSummary();
    const history = this.sharedMessages
      .slice(-10)
      .map(m => `[${m.source}]: ${m.content}`)
      .join('\n');

    const prompt = `You are coordinating a team of AI agents working on a task.

Available agents:
${capabilities}

Recent conversation:
${history || '(no messages yet)'}

Select the most appropriate agent to act next. Respond with JSON only:
{"selected_agent": "<agent name>", "reasoning": "<brief reason>"}`;

    try {
      const result = await this.modelClient.create([
        { role: 'user', content: prompt, source: 'orchestrator', timestamp: new Date() },
      ]);
      const match = result.message.content.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]) as AgentSelection;
        return this.findAgent(parsed.selected_agent);
      }
    } catch {
      // fall through to round-robin fallback
    }

    return this.agents[this.iterationCount % this.agents.length];
  }

  protected async prepareContext(_agent: BaseAgent): Promise<string> {
    const history = this.sharedMessages.map(m => `[${m.source}]: ${m.content}`).join('\n');
    return history
      ? `Context so far:\n\n${history}\n\nPlease continue.`
      : 'Please begin working on the task.';
  }

  protected async updateSharedState(result: AgentResponse): Promise<void> {
    this.sharedMessages.push(...result.messages.filter(m => m.role !== 'user'));
  }

  private findAgent(name: string): BaseAgent {
    const lower = name.toLowerCase();
    return (
      this.agents.find(a => a.name.toLowerCase() === lower) ??
      this.agents.find(
        a => a.name.toLowerCase().includes(lower) || lower.includes(a.name.toLowerCase()),
      ) ??
      this.agents[0]
    );
  }
}

// ---------------------------------------------------------------------------
// Plan-based orchestrator
// ---------------------------------------------------------------------------

interface PlanStep {
  task: string;
  agent_name: string;
  reasoning: string;
}

interface ExecutionPlan {
  steps: PlanStep[];
}

export class PlanBasedOrchestrator extends BaseOrchestrator {
  private modelClient: BaseChatClient;
  private maxStepRetries: number;
  private executionPlan: ExecutionPlan | null = null;
  private currentStepIndex = 0;
  private currentStepRetryCount = 0;
  private retryInstructions: Record<number, string> = {};

  constructor(
    agents: BaseAgent[],
    termination: TerminationCondition,
    modelClient: BaseChatClient,
    maxIterations = 50,
    maxStepRetries = 3,
  ) {
    super(agents, termination, maxIterations);
    this.modelClient = modelClient;
    this.maxStepRetries = maxStepRetries;
  }

  protected async selectNextAgent(): Promise<BaseAgent> {
    if (!this.executionPlan) {
      const task = this.sharedMessages[0]?.content ?? '';
      this.executionPlan = await this.createPlan(task);
    }

    if (this.currentStepIndex >= this.executionPlan.steps.length) {
      return this.agents[0];
    }

    return this.findAgent(this.executionPlan.steps[this.currentStepIndex].agent_name);
  }

  protected async prepareContext(_agent: BaseAgent): Promise<string> {
    if (!this.executionPlan || this.currentStepIndex >= this.executionPlan.steps.length) {
      return this.sharedMessages.map(m => `[${m.source}]: ${m.content}`).join('\n');
    }

    const step = this.executionPlan.steps[this.currentStepIndex];
    let task = `STEP ${this.currentStepIndex + 1}: ${step.task}`;

    if (this.currentStepRetryCount > 0 && this.retryInstructions[this.currentStepIndex]) {
      task += `\n\nRETRY (Attempt ${this.currentStepRetryCount + 1}):\n${this.retryInstructions[this.currentStepIndex]}`;
    }

    const recentContext = this.sharedMessages
      .slice(-5)
      .map(m => `[${m.source}]: ${m.content}`)
      .join('\n');
    return recentContext ? `${recentContext}\n\n${task}` : task;
  }

  protected async updateSharedState(result: AgentResponse): Promise<void> {
    const newMessages = result.messages.filter(m => m.role !== 'user');
    this.sharedMessages.push(...newMessages);

    if (!this.executionPlan || this.currentStepIndex >= this.executionPlan.steps.length) return;

    const step = this.executionPlan.steps[this.currentStepIndex];
    const completed = await this.evaluateStep(step, result);

    if (completed) {
      this.currentStepIndex++;
      this.currentStepRetryCount = 0;
    } else {
      this.currentStepRetryCount++;
      if (this.currentStepRetryCount > this.maxStepRetries) {
        this.currentStepIndex++;
        this.currentStepRetryCount = 0;
      } else {
        this.retryInstructions[this.currentStepIndex] =
          `Previous attempt did not complete step "${step.task}". Please try a different approach.`;
      }
    }
  }

  private async createPlan(task: string): Promise<ExecutionPlan> {
    const capabilities = this.getAgentCapabilitiesSummary();
    const prompt = `Break down this task into steps and assign each to an appropriate agent.

Available agents:
${capabilities}

Task: ${task}

Respond with JSON only:
{"steps": [{"task": "...", "agent_name": "...", "reasoning": "..."}]}`;

    try {
      const result = await this.modelClient.create([
        { role: 'user', content: prompt, source: 'planner', timestamp: new Date() },
      ]);
      const match = result.message.content.match(/\{[\s\S]*\}/);
      if (match) {
        return JSON.parse(match[0]) as ExecutionPlan;
      }
    } catch {
      // fall through to fallback
    }

    return {
      steps: [{ task, agent_name: this.agents[0].name, reasoning: 'Fallback single-step plan' }],
    };
  }

  private async evaluateStep(step: PlanStep, result: AgentResponse): Promise<boolean> {
    const output = result.messages
      .filter(m => m.role === 'assistant')
      .map(m => m.content)
      .join('\n');

    if (!output.trim()) return false;

    const prompt = `Did the agent successfully complete this step?

Step: ${step.task}
Agent output: ${output}

Respond with JSON only: {"completed": true, "reason": "..."} or {"completed": false, "reason": "..."}`;

    try {
      const evalResult = await this.modelClient.create([
        { role: 'user', content: prompt, source: 'evaluator', timestamp: new Date() },
      ]);
      const match = evalResult.message.content.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]) as { completed: boolean };
        return parsed.completed;
      }
    } catch {
      // fall through to heuristic
    }

    const lower = output.toLowerCase();
    return (
      output.length > 20 &&
      !['error', 'failed', 'cannot', 'unable'].some(w => lower.includes(w))
    );
  }

  private findAgent(name: string): BaseAgent {
    const lower = name.toLowerCase();
    return (
      this.agents.find(a => a.name.toLowerCase() === lower) ??
      this.agents.find(
        a => a.name.toLowerCase().includes(lower) || lower.includes(a.name.toLowerCase()),
      ) ??
      this.agents[0]
    );
  }

  protected reset(): void {
    super.reset();
    this.executionPlan = null;
    this.currentStepIndex = 0;
    this.currentStepRetryCount = 0;
    this.retryInstructions = {};
  }
}
