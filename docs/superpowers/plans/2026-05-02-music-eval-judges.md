# Music Eval Judges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-contained exercise in `src/exercises/music-eval/` that runs four agent configurations against four music tasks, scores each response with four LLM judges, and renders results in a Chart.js HTML report.

**Architecture:** Six files with single responsibilities: `types.ts` (interfaces), `tasks.ts` (data), `judges.ts` (judge hierarchy), `configs.ts` (runner factories + TokenCountingMiddleware), `report.ts` (HTML rendering), `index.ts` (entrypoint). Each file imports only what it needs from the existing `src/` framework.

**Tech Stack:** TypeScript, ts-node, vitest, OpenAI SDK (via existing `OpenAIChatClient`), Chart.js from CDN (no new npm dependencies).

---

## File Map

| File | Create/Modify | Responsibility |
|---|---|---|
| `src/exercises/music-eval/types.ts` | Create | Shared interfaces: `MusicTask`, `JudgeScore`, `ConfigResult`, `EvalResult`, `RunConfig` |
| `src/exercises/music-eval/tasks.ts` | Create | 4 `MusicTask` objects with prompts and ground-truth answers |
| `src/exercises/music-eval/tasks.test.ts` | Create | Structural tests for tasks |
| `src/exercises/music-eval/judges.ts` | Create | `LLMJudge` → `MusicJudge` → `ReasoningJudge`, `VerificationJudge`, `PlanningJudge`, `ToolUseJudge` |
| `src/exercises/music-eval/judges.test.ts` | Create | JSON parsing, fallback, groundTruth inclusion |
| `src/exercises/music-eval/configs.ts` | Create | `TokenCountingMiddleware` + 4 `RunConfig` factories |
| `src/exercises/music-eval/configs.test.ts` | Create | Middleware accumulation, direct config shape |
| `src/exercises/music-eval/report.ts` | Create | `renderReport(results)` → self-contained HTML string |
| `src/exercises/music-eval/report.test.ts` | Create | HTML structure, Chart.js CDN, data inclusion |
| `src/exercises/music-eval/index.ts` | Create | Entrypoint: sequential eval loop + write report.html |

---

### Task 1: Create `types.ts`

**Files:**
- Create: `src/exercises/music-eval/types.ts`

- [ ] **Step 1: Create the file**

```typescript
// src/exercises/music-eval/types.ts

export interface MusicTask {
  id: string;
  prompt: string;
  groundTruth: string;
}

export interface JudgeScore {
  judgeName: string;
  score: number;         // 0–10
  justification: string;
}

export interface ConfigResult {
  configName: string;
  taskId: string;
  response: string;
  usage: { tokens: number; tokensOutput: number };
}

export interface EvalResult extends ConfigResult {
  judgeScores: JudgeScore[];
  averageScore: number;
  scorePerThousandTokens: number;
}

export type RunConfig = (task: MusicTask) => Promise<ConfigResult>;
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/exercises/music-eval/types.ts
git commit -m "feat(music-eval): add shared type definitions"
```

---

### Task 2: Create `tasks.ts` with tests

**Files:**
- Create: `src/exercises/music-eval/tasks.ts`
- Create: `src/exercises/music-eval/tasks.test.ts`

The shared ABC score used in all task prompts:
```
X:1
T:Ode Fragment
M:4/4
K:C
|: C D E F | G4 | E D C2 | G,4 :|
```

- [ ] **Step 1: Write the failing test**

```typescript
// src/exercises/music-eval/tasks.test.ts
import { describe, it, expect } from 'vitest';
import { MUSIC_TASKS } from './tasks';

describe('MUSIC_TASKS', () => {
  it('exports exactly 4 tasks', () => {
    expect(MUSIC_TASKS).toHaveLength(4);
  });

  it('each task has a non-empty id, prompt, and groundTruth', () => {
    for (const task of MUSIC_TASKS) {
      expect(task.id.length).toBeGreaterThan(0);
      expect(task.prompt.length).toBeGreaterThan(0);
      expect(task.groundTruth.length).toBeGreaterThan(0);
    }
  });

  it('task ids are unique', () => {
    const ids = MUSIC_TASKS.map(t => t.id);
    expect(new Set(ids).size).toBe(4);
  });

  it('has tasks with ids: transcribe, find-composer, generate, check-facts', () => {
    const ids = MUSIC_TASKS.map(t => t.id);
    expect(ids).toContain('transcribe');
    expect(ids).toContain('find-composer');
    expect(ids).toContain('generate');
    expect(ids).toContain('check-facts');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/exercises/music-eval/tasks.test.ts
```

Expected: FAIL — `Cannot find module './tasks'`

- [ ] **Step 3: Implement `tasks.ts`**

```typescript
// src/exercises/music-eval/tasks.ts
import { MusicTask } from './types';

const SCORE = `X:1
T:Ode Fragment
M:4/4
K:C
|: C D E F | G4 | E D C2 | G,4 :|`;

export const MUSIC_TASKS: MusicTask[] = [
  {
    id: 'transcribe',
    prompt: `Transcribe the following ABC notation score to readable notation, listing each note with its name and duration and marking bar lines clearly.

${SCORE}`,
    groundTruth:
      'Bar 1: C quarter, D quarter, E quarter, F quarter. Bar 2: G whole. Bar 3: E quarter, D quarter, C half. Bar 4: G, whole.',
  },
  {
    id: 'find-composer',
    prompt: `The following score is marked "after BWV 147 fragment, adapted". Identify the most likely original composer and briefly explain the BWV reference.

${SCORE}`,
    groundTruth: 'Johann Sebastian Bach',
  },
  {
    id: 'generate',
    prompt: `Using only the notes C D E G A (C major pentatonic), compose a short 8-bar melody in 4/4 time. Follow classical conventions: balanced phrase structure, stepwise motion, and a clear sense of opening and closing. Write the melody as bar-by-bar note names with durations.`,
    groundTruth:
      'Bar 1: C E G E | Bar 2: A G E C | Bar 3: D E G A | Bar 4: G4 | Bar 5: E G A G | Bar 6: E D C2 | Bar 7: G A G E | Bar 8: C4',
  },
  {
    id: 'check-facts',
    prompt: `Review these five statements about Johann Sebastian Bach and identify which ones are incorrect:

1. Bach was born in 1685 in Eisenach, Germany.
2. Bach was born in 1675 in Leipzig, Germany.
3. Bach composed the Brandenburg Concertos.
4. Bach had 20 children across two marriages.
5. Bach had 10 children.

List only the incorrect statements by number and explain briefly why each is wrong.`,
    groundTruth:
      'Statement 2 is incorrect (Bach was born in 1685, not 1675, and in Eisenach not Leipzig). Statement 5 is incorrect (Bach had 20 children, not 10).',
  },
];
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/exercises/music-eval/tasks.test.ts
```

Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/exercises/music-eval/tasks.ts src/exercises/music-eval/tasks.test.ts
git commit -m "feat(music-eval): add music tasks with ground truth answers"
```

---

### Task 3: Create `judges.ts` with tests

**Files:**
- Create: `src/exercises/music-eval/judges.ts`
- Create: `src/exercises/music-eval/judges.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/exercises/music-eval/judges.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { BaseChatClient } from '../../client';
import type { MusicTask } from './types';
import {
  ReasoningJudge,
  VerificationJudge,
  PlanningJudge,
  ToolUseJudge,
} from './judges';

function makeClient(responseContent: string): BaseChatClient {
  return {
    create: vi.fn().mockResolvedValue({
      message: {
        role: 'assistant' as const,
        content: responseContent,
        source: 'judge',
        timestamp: new Date(),
      },
    }),
    createStream: vi.fn(),
  } as unknown as BaseChatClient;
}

const sampleTask: MusicTask = {
  id: 'transcribe',
  prompt: 'Transcribe this score.',
  groundTruth: 'Bar 1: C quarter, D quarter.',
};

describe('LLMJudge — JSON parsing', () => {
  it('parses a valid JSON score from the model response', async () => {
    const client = makeClient('{"score": 7, "justification": "Good reasoning."}');
    const judge = new ReasoningJudge(client);
    const result = await judge.judge(sampleTask, 'The notes are C D E F.');
    expect(result.score).toBe(7);
    expect(result.justification).toBe('Good reasoning.');
    expect(result.judgeName).toBe('ReasoningJudge');
  });

  it('parses JSON embedded in surrounding text', async () => {
    const client = makeClient('Here is my evaluation: {"score": 5, "justification": "Average."} Done.');
    const judge = new ReasoningJudge(client);
    const result = await judge.judge(sampleTask, 'Some response.');
    expect(result.score).toBe(5);
  });

  it('returns score 0 with fallback justification when JSON is malformed', async () => {
    const client = makeClient('I cannot score this.');
    const judge = new ReasoningJudge(client);
    const result = await judge.judge(sampleTask, 'Some response.');
    expect(result.score).toBe(0);
    expect(result.justification).toBe('Failed to parse judge response');
  });

  it('clamps scores to 0–10', async () => {
    const client = makeClient('{"score": 15, "justification": "Off the charts."}');
    const judge = new ReasoningJudge(client);
    const result = await judge.judge(sampleTask, 'Some response.');
    expect(result.score).toBe(10);
  });
});

describe('VerificationJudge', () => {
  it('includes task.groundTruth in the prompt sent to the model', async () => {
    const client = makeClient('{"score": 8, "justification": "Matches."}');
    const judge = new VerificationJudge(client);
    await judge.judge(sampleTask, 'Bar 1: C quarter, D quarter.');
    const [messages] = (client.create as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Array<{ content: string }>,
    ];
    expect(messages[0]!.content).toContain('Bar 1: C quarter, D quarter.');
  });
});

describe('concrete judge names', () => {
  it('each judge reports its class name', async () => {
    const client = makeClient('{"score": 5, "justification": "ok"}');
    expect((await new ReasoningJudge(client).judge(sampleTask, '')).judgeName).toBe('ReasoningJudge');
    expect((await new VerificationJudge(client).judge(sampleTask, '')).judgeName).toBe('VerificationJudge');
    expect((await new PlanningJudge(client).judge(sampleTask, '')).judgeName).toBe('PlanningJudge');
    expect((await new ToolUseJudge(client).judge(sampleTask, '')).judgeName).toBe('ToolUseJudge');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/exercises/music-eval/judges.test.ts
```

Expected: FAIL — `Cannot find module './judges'`

- [ ] **Step 3: Implement `judges.ts`**

```typescript
// src/exercises/music-eval/judges.ts
import { BaseChatClient } from '../../client';
import { MusicTask, JudgeScore } from './types';

const MUSIC_PREAMBLE = `You are evaluating a music-domain AI response.
Score highly if the response follows classical music conventions.
Score highly if facts about composers are detailed and rich.
Score 0–10. Respond with JSON only: {"score": <number 0-10>, "justification": "<string>"}`;

export abstract class LLMJudge {
  constructor(protected readonly modelClient: BaseChatClient) {}

  get name(): string {
    return this.constructor.name;
  }

  protected abstract readonly criteriaPrompt: string;

  protected buildPrompt(task: MusicTask, response: string): string {
    return `${this.criteriaPrompt}\n\nTask: ${task.prompt}\n\nResponse to evaluate:\n${response}`;
  }

  async judge(task: MusicTask, response: string): Promise<JudgeScore> {
    const prompt = this.buildPrompt(task, response);
    const result = await this.modelClient.create([
      { role: 'user', content: prompt, source: 'judge', timestamp: new Date() },
    ]);
    return this.parseScore(result.message.content);
  }

  private parseScore(content: string): JudgeScore {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]) as { score: unknown; justification: unknown };
        const score =
          typeof parsed.score === 'number' ? Math.max(0, Math.min(10, parsed.score)) : 0;
        const justification =
          typeof parsed.justification === 'string' ? parsed.justification : '';
        return { judgeName: this.name, score, justification };
      } catch {
        // fall through to fallback
      }
    }
    return { judgeName: this.name, score: 0, justification: 'Failed to parse judge response' };
  }
}

export abstract class MusicJudge extends LLMJudge {
  protected buildPrompt(task: MusicTask, response: string): string {
    return `${MUSIC_PREAMBLE}\n\n${this.criteriaPrompt}\n\nTask: ${task.prompt}\n\nResponse to evaluate:\n${response}`;
  }
}

export class ReasoningJudge extends MusicJudge {
  protected readonly criteriaPrompt = `Evaluate logical coherence and step-by-step reasoning.
Award high scores for clear logical steps, correct musical reasoning, and absence of non-sequiturs.
Award low scores for contradictions, unsupported claims, or illogical leaps.`;
}

export class VerificationJudge extends MusicJudge {
  protected readonly criteriaPrompt = `Evaluate closeness to the expected answer. Deduct points for each deviation from it.`;

  protected buildPrompt(task: MusicTask, response: string): string {
    return `${MUSIC_PREAMBLE}\n\n${this.criteriaPrompt}\n\nExpected answer:\n${task.groundTruth}\n\nTask: ${task.prompt}\n\nResponse to evaluate:\n${response}`;
  }
}

export class PlanningJudge extends MusicJudge {
  protected readonly criteriaPrompt = `Evaluate evidence of structured planning and decomposition.
Award high scores for methodical, step-by-step approaches and systematic handling of the task.
Award low scores for ad hoc, unstructured, or disorganised responses.`;
}

export class ToolUseJudge extends MusicJudge {
  protected readonly criteriaPrompt = `Evaluate appropriate use of tools (function calls, lookups, etc.).
Award high scores for responses that show evidence of tool invocations with correct parameters and effective use of tool results.
If the response contains no tool use evidence at all, score 0–2.`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/exercises/music-eval/judges.test.ts
```

Expected: PASS — 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/exercises/music-eval/judges.ts src/exercises/music-eval/judges.test.ts
git commit -m "feat(music-eval): add LLMJudge hierarchy with 4 concrete music judges"
```

---

### Task 4: Create `configs.ts` with tests

**Files:**
- Create: `src/exercises/music-eval/configs.ts`
- Create: `src/exercises/music-eval/configs.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/exercises/music-eval/configs.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TokenCountingMiddleware, makeDirectConfig } from './configs';
import type { MiddlewareContext } from '../../middleware';
import type { ChatCompletionResult } from '../../types';
import type { MusicTask } from './types';

// Mock OpenAIChatClient so makeDirectConfig doesn't make real API calls
vi.mock('../../client', () => ({
  OpenAIChatClient: vi.fn().mockImplementation(() => ({
    create: vi.fn().mockResolvedValue({
      message: {
        role: 'assistant' as const,
        content: 'Johann Sebastian Bach composed this.',
        source: 'assistant',
        timestamp: new Date(),
      },
      usage: { tokens: 120, tokensOutput: 60 },
    }),
    createStream: vi.fn(),
  })),
}));

const modelCallCtx: MiddlewareContext = {
  operation: 'model_call',
  agentName: 'test',
  agentContext: {} as never,
  data: {},
  metadata: {},
};

const toolCallCtx: MiddlewareContext = {
  operation: 'tool_call',
  agentName: 'test',
  agentContext: {} as never,
  data: {},
  metadata: {},
};

const mockCompletionResult: ChatCompletionResult = {
  message: {
    role: 'assistant' as const,
    content: 'test',
    source: 'assistant',
    timestamp: new Date(),
  },
  usage: { tokens: 200, tokensOutput: 80 },
};

describe('TokenCountingMiddleware', () => {
  it('accumulates tokens from model_call operations', async () => {
    const middleware = new TokenCountingMiddleware();
    await middleware.processResponse(modelCallCtx, mockCompletionResult);
    await middleware.processResponse(modelCallCtx, mockCompletionResult);
    expect(middleware.tokens).toBe(400);
    expect(middleware.tokensOutput).toBe(160);
  });

  it('ignores tool_call operations', async () => {
    const middleware = new TokenCountingMiddleware();
    await middleware.processResponse(toolCallCtx, { someToolResult: true });
    expect(middleware.tokens).toBe(0);
    expect(middleware.tokensOutput).toBe(0);
  });

  it('returns the result unchanged from processResponse', async () => {
    const middleware = new TokenCountingMiddleware();
    const returned = await middleware.processResponse(modelCallCtx, mockCompletionResult);
    expect(returned).toBe(mockCompletionResult);
  });
});

describe('makeDirectConfig', () => {
  const task: MusicTask = {
    id: 'find-composer',
    prompt: 'Who wrote this score?',
    groundTruth: 'Johann Sebastian Bach',
  };

  it('returns a ConfigResult with configName "direct" and matching taskId', async () => {
    const config = makeDirectConfig();
    const result = await config(task);
    expect(result.configName).toBe('direct');
    expect(result.taskId).toBe('find-composer');
  });

  it('returns a non-empty response', async () => {
    const config = makeDirectConfig();
    const result = await config(task);
    expect(result.response.length).toBeGreaterThan(0);
  });

  it('returns usage data from the model call', async () => {
    const config = makeDirectConfig();
    const result = await config(task);
    expect(result.usage.tokens).toBe(120);
    expect(result.usage.tokensOutput).toBe(60);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/exercises/music-eval/configs.test.ts
```

Expected: FAIL — `Cannot find module './configs'`

- [ ] **Step 3: Implement `configs.ts`**

```typescript
// src/exercises/music-eval/configs.ts
import { OpenAIAgent } from '../../openai-agent';
import { OpenAIChatClient } from '../../client';
import {
  RoundRobinOrchestrator,
  AIOrchestrator,
  MaxMessageTermination,
} from '../../orchestrator';
import { FunctionTool } from '../../tool';
import { BaseMiddleware, MiddlewareContext } from '../../middleware';
import { ChatCompletionResult } from '../../types';
import { MusicTask, ConfigResult, RunConfig } from './types';

// ---------------------------------------------------------------------------
// Token counting middleware — accumulates usage from model calls
// ---------------------------------------------------------------------------

export class TokenCountingMiddleware extends BaseMiddleware {
  tokens = 0;
  tokensOutput = 0;

  async processResponse(context: MiddlewareContext, result: unknown): Promise<unknown> {
    if (context.operation === 'model_call') {
      const r = result as ChatCompletionResult;
      if (r.usage) {
        this.tokens += r.usage.tokens;
        this.tokensOutput += r.usage.tokensOutput;
      }
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Shared music tools (stubs — return guidance strings, not real data)
// ---------------------------------------------------------------------------

function makeMusicTools() {
  return [
    new FunctionTool(
      (p) =>
        `Biographical stub for composer "${p['name']}": born in the Baroque/Classical period, ` +
        `known for contrapuntal and harmonic mastery. Consult authoritative sources for details.`,
      'lookup_composer',
      'Look up biographical information about a composer by name.',
      {
        type: 'object',
        properties: { name: { type: 'string', description: 'Full composer name' } },
        required: ['name'],
      },
    ),
    new FunctionTool(
      (p) =>
        `Music theory guidance for "${p['question']}": apply voice-leading rules, ` +
        `ensure stepwise motion where possible, and resolve tendency tones.`,
      'check_theory',
      'Get music theory guidance for a question about harmony, rhythm, or notation.',
      {
        type: 'object',
        properties: { question: { type: 'string', description: 'The theory question' } },
        required: ['question'],
      },
    ),
    new FunctionTool(
      (p) =>
        `Transcription guidance for ABC "${p['abc']}": ` +
        `read note letters as pitch names, numbers as durations relative to L: unit, ` +
        `| as bar lines, and : as repeat markers.`,
      'transcribe_notation',
      'Get guidance for transcribing an ABC notation string to readable note names.',
      {
        type: 'object',
        properties: { abc: { type: 'string', description: 'The ABC notation string' } },
        required: ['abc'],
      },
    ),
  ];
}

// ---------------------------------------------------------------------------
// Config 1: Single agent with music tools
// ---------------------------------------------------------------------------

export function makeSingleAgentConfig(): RunConfig {
  return async (task: MusicTask): Promise<ConfigResult> => {
    const counter = new TokenCountingMiddleware();
    const agent = new OpenAIAgent(
      'music-agent',
      'You are a music expert. Use your tools to answer music questions accurately and in detail.',
      { tools: makeMusicTools(), middleware: [counter] },
    );
    const result = await agent.run(task.prompt);
    const response = result.messages
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content)
      .join('\n');
    return {
      configName: 'single-agent',
      taskId: task.id,
      response,
      usage: { tokens: counter.tokens, tokensOutput: counter.tokensOutput },
    };
  };
}

// ---------------------------------------------------------------------------
// Config 2: Round-robin orchestrator (MusicAnalyst + MusicCritic)
// ---------------------------------------------------------------------------

export function makeRoundRobinConfig(): RunConfig {
  return async (task: MusicTask): Promise<ConfigResult> => {
    const counter1 = new TokenCountingMiddleware();
    const counter2 = new TokenCountingMiddleware();
    const analyst = new OpenAIAgent(
      'music-analyst',
      'You are a music analyst. Analyse musical content carefully and provide detailed, accurate findings.',
      { middleware: [counter1] },
    );
    const critic = new OpenAIAgent(
      'music-critic',
      'You are a music critic. Review the analyst\'s findings, correct any errors, and add detail.',
      { middleware: [counter2] },
    );
    const orchestrator = new RoundRobinOrchestrator(
      [analyst, critic],
      new MaxMessageTermination(4),
    );
    const result = await orchestrator.run(task.prompt);
    return {
      configName: 'round-robin',
      taskId: task.id,
      response: result.finalResult,
      usage: {
        tokens: counter1.tokens + counter2.tokens,
        tokensOutput: counter1.tokensOutput + counter2.tokensOutput,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Config 3: AI-driven orchestrator (same agents, orchestrator picks who goes next)
// Note: orchestrator routing calls are not counted in usage (no middleware access)
// ---------------------------------------------------------------------------

export function makeAIConfig(): RunConfig {
  return async (task: MusicTask): Promise<ConfigResult> => {
    const counter1 = new TokenCountingMiddleware();
    const counter2 = new TokenCountingMiddleware();
    const analyst = new OpenAIAgent(
      'music-analyst',
      'You are a music analyst. Analyse musical content carefully and provide detailed, accurate findings.',
      { middleware: [counter1] },
    );
    const critic = new OpenAIAgent(
      'music-critic',
      'You are a music critic. Review the analyst\'s findings, correct any errors, and add detail.',
      { middleware: [counter2] },
    );
    const orchestratorClient = new OpenAIChatClient('gpt-4o-mini');
    const orchestrator = new AIOrchestrator(
      [analyst, critic],
      new MaxMessageTermination(4),
      orchestratorClient,
    );
    const result = await orchestrator.run(task.prompt);
    return {
      configName: 'ai-orchestrated',
      taskId: task.id,
      response: result.finalResult,
      usage: {
        tokens: counter1.tokens + counter2.tokens,
        tokensOutput: counter1.tokensOutput + counter2.tokensOutput,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Config 4: Direct model call — no agent, no system prompt, no tools
// ---------------------------------------------------------------------------

export function makeDirectConfig(): RunConfig {
  return async (task: MusicTask): Promise<ConfigResult> => {
    const client = new OpenAIChatClient('gpt-4o-mini');
    const result = await client.create([
      { role: 'user', content: task.prompt, source: 'user', timestamp: new Date() },
    ]);
    return {
      configName: 'direct',
      taskId: task.id,
      response: result.message.content,
      usage: result.usage ?? { tokens: 0, tokensOutput: 0 },
    };
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/exercises/music-eval/configs.test.ts
```

Expected: PASS — 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/exercises/music-eval/configs.ts src/exercises/music-eval/configs.test.ts
git commit -m "feat(music-eval): add RunConfig factories and TokenCountingMiddleware"
```

---

### Task 5: Create `report.ts` with tests

**Files:**
- Create: `src/exercises/music-eval/report.ts`
- Create: `src/exercises/music-eval/report.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/exercises/music-eval/report.test.ts
import { describe, it, expect } from 'vitest';
import { renderReport } from './report';
import type { EvalResult } from './types';

function makeResult(overrides: Partial<EvalResult> = {}): EvalResult {
  return {
    configName: 'direct',
    taskId: 'transcribe',
    response: 'Bar 1: C D E F.',
    usage: { tokens: 100, tokensOutput: 50 },
    judgeScores: [
      { judgeName: 'ReasoningJudge', score: 7, justification: 'Good.' },
      { judgeName: 'VerificationJudge', score: 6, justification: 'Close.' },
      { judgeName: 'PlanningJudge', score: 5, justification: 'Average.' },
      { judgeName: 'ToolUseJudge', score: 1, justification: 'No tools.' },
    ],
    averageScore: 4.75,
    scorePerThousandTokens: 31.67,
    ...overrides,
  };
}

describe('renderReport', () => {
  it('returns a string starting with <!DOCTYPE html>', () => {
    const html = renderReport([]);
    expect(html.trimStart()).toMatch(/^<!DOCTYPE html>/i);
  });

  it('includes Chart.js CDN script tag', () => {
    const html = renderReport([]);
    expect(html).toContain('cdn.jsdelivr.net/npm/chart.js');
  });

  it('includes all four config names when results are present', () => {
    const results: EvalResult[] = [
      makeResult({ configName: 'single-agent', taskId: 'transcribe' }),
      makeResult({ configName: 'round-robin', taskId: 'transcribe' }),
      makeResult({ configName: 'ai-orchestrated', taskId: 'transcribe' }),
      makeResult({ configName: 'direct', taskId: 'transcribe' }),
    ];
    const html = renderReport(results);
    expect(html).toContain('single-agent');
    expect(html).toContain('round-robin');
    expect(html).toContain('ai-orchestrated');
    expect(html).toContain('direct');
  });

  it('includes all four task IDs when results are present', () => {
    const tasks = ['transcribe', 'find-composer', 'generate', 'check-facts'];
    const results = tasks.map((id) => makeResult({ taskId: id }));
    const html = renderReport(results);
    for (const id of tasks) {
      expect(html).toContain(id);
    }
  });

  it('includes three canvas elements for the three charts', () => {
    const html = renderReport([makeResult()]);
    const canvasCount = (html.match(/<canvas/g) ?? []).length;
    expect(canvasCount).toBe(3);
  });

  it('includes a summary table with judge score columns', () => {
    const html = renderReport([makeResult()]);
    expect(html).toContain('ReasoningJudge');
    expect(html).toContain('VerificationJudge');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/exercises/music-eval/report.test.ts
```

Expected: FAIL — `Cannot find module './report'`

- [ ] **Step 3: Implement `report.ts`**

```typescript
// src/exercises/music-eval/report.ts
import { EvalResult } from './types';

const CONFIGS = ['single-agent', 'round-robin', 'ai-orchestrated', 'direct'];
const TASKS = ['transcribe', 'find-composer', 'generate', 'check-facts'];
const COLORS = [
  'rgba(54,162,235,0.8)',
  'rgba(255,99,132,0.8)',
  'rgba(75,192,192,0.8)',
  'rgba(255,159,64,0.8)',
];

function avg(nums: number[]): number {
  if (!nums.length) return 0;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

export function renderReport(results: EvalResult[]): string {
  // Compute chart data
  const overallScores = CONFIGS.map((c) =>
    parseFloat(avg(results.filter((r) => r.configName === c).map((r) => r.averageScore)).toFixed(2)),
  );

  const efficiencyDatasets = CONFIGS.map((c, i) => ({
    label: c,
    backgroundColor: COLORS[i],
    data: TASKS.map((t) => {
      const r = results.find((r) => r.configName === c && r.taskId === t);
      return r ? parseFloat(r.scorePerThousandTokens.toFixed(2)) : 0;
    }),
  }));

  const scoreDatasets = CONFIGS.map((c, i) => ({
    label: c,
    backgroundColor: COLORS[i],
    data: TASKS.map((t) => {
      const r = results.find((r) => r.configName === c && r.taskId === t);
      return r ? parseFloat(r.averageScore.toFixed(2)) : 0;
    }),
  }));

  // Derive judge names from first result (if any)
  const judgeNames =
    results[0]?.judgeScores.map((js) => js.judgeName) ??
    ['ReasoningJudge', 'VerificationJudge', 'PlanningJudge', 'ToolUseJudge'];

  // Build detail table rows
  const tableRows = results
    .map((r) => {
      const judgeScoreCells = judgeNames
        .map((jn) => {
          const js = r.judgeScores.find((s) => s.judgeName === jn);
          return `<td title="${js?.justification ?? ''}">${js?.score ?? '-'}</td>`;
        })
        .join('');
      const totalTokens = r.usage.tokens + r.usage.tokensOutput;
      return `<tr>
        <td>${r.configName}</td>
        <td>${r.taskId}</td>
        <td>${r.averageScore.toFixed(2)}</td>
        <td>${totalTokens}</td>
        <td>${r.scorePerThousandTokens.toFixed(2)}</td>
        ${judgeScoreCells}
      </tr>`;
    })
    .join('\n');

  const judgeHeaders = judgeNames.map((jn) => `<th>${jn}</th>`).join('');

  const chartData = JSON.stringify({ overallScores, efficiencyDatasets, scoreDatasets, CONFIGS, TASKS });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Music Eval Report</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body { font-family: sans-serif; max-width: 1100px; margin: 0 auto; padding: 2rem; color: #222; }
    h1 { margin-bottom: 0.25rem; }
    .meta { color: #666; font-size: 0.9rem; margin-bottom: 2rem; }
    .chart-wrap { position: relative; height: 320px; margin: 2.5rem 0; }
    h2 { margin-bottom: 0.5rem; }
    table { width: 100%; border-collapse: collapse; margin-top: 2rem; font-size: 0.85rem; }
    th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; }
    th { background: #f5f5f5; font-weight: 600; }
    tr:nth-child(even) { background: #fafafa; }
    td[title] { cursor: help; }
  </style>
</head>
<body>
  <h1>Music Eval Report</h1>
  <p class="meta">Generated: ${new Date().toISOString()} &nbsp;|&nbsp; ${CONFIGS.length} configurations &nbsp;|&nbsp; ${TASKS.length} tasks &nbsp;|&nbsp; ${results.length} results</p>

  <h2>Overall Performance (average score across all tasks)</h2>
  <div class="chart-wrap"><canvas id="overallChart"></canvas></div>

  <h2>Token Efficiency by Task (score per 1 000 tokens)</h2>
  <div class="chart-wrap"><canvas id="efficiencyChart"></canvas></div>

  <h2>Performance by Task (average judge score)</h2>
  <div class="chart-wrap"><canvas id="taskChart"></canvas></div>

  <h2>Detail</h2>
  <table>
    <thead>
      <tr>
        <th>Config</th><th>Task</th><th>Avg Score</th><th>Total Tokens</th><th>Score/1k Tokens</th>
        ${judgeHeaders}
      </tr>
    </thead>
    <tbody>
      ${tableRows}
    </tbody>
  </table>

  <script>
    const d = ${chartData};

    new Chart(document.getElementById('overallChart'), {
      type: 'bar',
      data: {
        labels: d.CONFIGS,
        datasets: [{
          label: 'Average Score (0–10)',
          data: d.overallScores,
          backgroundColor: ${JSON.stringify(COLORS)},
        }],
      },
      options: {
        indexAxis: 'y',
        scales: { x: { min: 0, max: 10, title: { display: true, text: 'Score' } } },
        plugins: { legend: { display: false } },
      },
    });

    new Chart(document.getElementById('efficiencyChart'), {
      type: 'bar',
      data: { labels: d.TASKS, datasets: d.efficiencyDatasets },
      options: {
        scales: { y: { min: 0, title: { display: true, text: 'Score / 1k tokens' } } },
        plugins: { legend: { position: 'top' } },
      },
    });

    new Chart(document.getElementById('taskChart'), {
      type: 'bar',
      data: { labels: d.TASKS, datasets: d.scoreDatasets },
      options: {
        scales: { y: { min: 0, max: 10, title: { display: true, text: 'Score (0–10)' } } },
        plugins: { legend: { position: 'top' } },
      },
    });
  </script>
</body>
</html>`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/exercises/music-eval/report.test.ts
```

Expected: PASS — 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/exercises/music-eval/report.ts src/exercises/music-eval/report.test.ts
git commit -m "feat(music-eval): add Chart.js HTML report renderer"
```

---

### Task 6: Create `index.ts` and run full test suite

**Files:**
- Create: `src/exercises/music-eval/index.ts`

- [ ] **Step 1: Implement `index.ts`**

```typescript
// src/exercises/music-eval/index.ts
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { OpenAIChatClient } from '../../client';
import { MUSIC_TASKS } from './tasks';
import {
  ReasoningJudge,
  VerificationJudge,
  PlanningJudge,
  ToolUseJudge,
  LLMJudge,
} from './judges';
import {
  makeSingleAgentConfig,
  makeRoundRobinConfig,
  makeAIConfig,
  makeDirectConfig,
} from './configs';
import { renderReport } from './report';
import { EvalResult, ConfigResult, JudgeScore, RunConfig } from './types';

dotenv.config();

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error(`${RED}Error: OPENAI_API_KEY is not set.${RESET}`);
    process.exit(1);
  }

  console.log(`\n${BOLD}Music Eval — Custom LLM Judges${RESET}`);
  console.log(`${DIM}4 configurations × 4 tasks × 4 judges = 64 judge calls + agent calls${RESET}\n`);

  const judgeClient = new OpenAIChatClient('gpt-4o-mini');
  const judges: LLMJudge[] = [
    new ReasoningJudge(judgeClient),
    new VerificationJudge(judgeClient),
    new PlanningJudge(judgeClient),
    new ToolUseJudge(judgeClient),
  ];

  const configs: Array<{ name: string; factory: () => RunConfig }> = [
    { name: 'single-agent', factory: makeSingleAgentConfig },
    { name: 'round-robin', factory: makeRoundRobinConfig },
    { name: 'ai-orchestrated', factory: makeAIConfig },
    { name: 'direct', factory: makeDirectConfig },
  ];

  const allResults: EvalResult[] = [];

  for (const { name, factory } of configs) {
    console.log(`${BOLD}${CYAN}[${name}]${RESET}`);
    const runConfig = factory();

    for (const task of MUSIC_TASKS) {
      process.stdout.write(`  ${DIM}task: ${task.id}${RESET} ... `);

      let configResult: ConfigResult;
      try {
        configResult = await runConfig(task);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`${RED}FAILED: ${msg}${RESET}`);
        continue;
      }

      const judgeScores: JudgeScore[] = [];
      for (const judge of judges) {
        try {
          judgeScores.push(await judge.judge(task, configResult.response));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          judgeScores.push({ judgeName: judge.name, score: 0, justification: `Error: ${msg}` });
        }
      }

      const averageScore =
        judgeScores.reduce((s, js) => s + js.score, 0) / judgeScores.length;
      const totalTokens = configResult.usage.tokens + configResult.usage.tokensOutput;
      const scorePerThousandTokens =
        totalTokens > 0 ? averageScore / (totalTokens / 1000) : 0;

      const evalResult: EvalResult = {
        ...configResult,
        judgeScores,
        averageScore,
        scorePerThousandTokens,
      };

      allResults.push(evalResult);
      console.log(`${GREEN}avg score: ${averageScore.toFixed(1)}${RESET}`);
    }
    console.log();
  }

  const reportPath = path.join(__dirname, 'report.html');
  fs.writeFileSync(reportPath, renderReport(allResults), 'utf-8');
  console.log(`${BOLD}${YELLOW}Report written to:${RESET} ${reportPath}`);
  console.log(`Open it in a browser to view the charts.\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run the full test suite to verify nothing is broken**

```bash
npm test
```

Expected: All tests pass. Output includes tests from `tasks.test.ts`, `judges.test.ts`, `configs.test.ts`, `report.test.ts`.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/exercises/music-eval/index.ts
git commit -m "feat(music-eval): add entrypoint — sequential eval loop and report writer"
```

---

## Running the exercise

```bash
# Requires OPENAI_API_KEY in environment or .env in project root
npx ts-node src/exercises/music-eval/index.ts
```

Open `src/exercises/music-eval/report.html` in a browser to view the three charts and detail table.
