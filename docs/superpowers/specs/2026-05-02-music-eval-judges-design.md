# Music Eval Judges — Design Spec

**Date:** 2026-05-02  
**Location:** `src/exercises/music-eval/`  
**Run:** `ts-node src/exercises/music-eval/index.ts`  
**Output:** `src/exercises/music-eval/report.html`

---

## Purpose

A self-contained exercise demonstrating custom LLM-based eval judges. Four judge classes evaluate four agent configurations against four music-domain tasks. Results are rendered in a Chart.js HTML report with three graphs.

---

## File Structure

```
src/exercises/music-eval/
  index.ts      # entrypoint: runs all configs × tasks sequentially, writes report.html
  types.ts      # shared interfaces
  tasks.ts      # 4 MusicTask objects with prompts and ground-truth answers
  judges.ts     # LLMJudge → MusicJudge → 4 concrete judge classes
  configs.ts    # 4 RunConfig factories
  report.ts     # renderReport(results) → self-contained HTML string
```

---

## Type System (`types.ts`)

```ts
interface MusicTask {
  id: string          // "transcribe" | "find-composer" | "generate" | "check-facts"
  prompt: string      // sent verbatim to each configuration
  groundTruth: string // reference answer used by VerificationJudge
}

interface JudgeScore {
  judgeName: string   // e.g. "ReasoningJudge"
  score: number       // 0–10
  justification: string
}

// Returned by RunConfig — no judge scores yet (those are computed in index.ts)
interface ConfigResult {
  configName: string
  taskId: string
  response: string
  usage: { tokens: number; tokensOutput: number }
}

// Fully populated after judge scoring in index.ts
interface EvalResult extends ConfigResult {
  judgeScores: JudgeScore[]
  averageScore: number               // mean of judgeScores[].score
  scorePerThousandTokens: number     // averageScore / ((tokens + tokensOutput) / 1000)
}

type RunConfig = (task: MusicTask) => Promise<ConfigResult>
```

---

## Judge Hierarchy (`judges.ts`)

### `LLMJudge` (abstract)
- `modelClient: OpenAIChatClient`
- `abstract criteriaPrompt: string`
- `judge(task: MusicTask, response: string): Promise<JudgeScore>`
  - Builds a prompt from `criteriaPrompt` + task prompt + response
  - Calls model, parses JSON `{ score: number, justification: string }`
  - Returns `JudgeScore` with `judgeName` set to the subclass constructor name

### `MusicJudge` (abstract, extends `LLMJudge`)
Prepends this shared preamble to every judge prompt:
> "You are evaluating a music-domain AI response. Score highly if the response follows classical music conventions. Score highly if facts about composers are detailed and rich. Score 0–10. Respond with JSON only: { \"score\": number, \"justification\": string }"

### Concrete judges (each extends `MusicJudge`)

| Class | `criteriaPrompt` focus |
|---|---|
| `ReasoningJudge` | Logical coherence, step-by-step reasoning, absence of non-sequiturs |
| `VerificationJudge` | Closeness to `task.groundTruth` — deduct points for each deviation |
| `PlanningJudge` | Evidence of structured decomposition, methodical approach |
| `ToolUseJudge` | Appropriate tool invocations, correct parameters, tool results used effectively |

`VerificationJudge` is the only judge that includes `task.groundTruth` in its prompt.

`ToolUseJudge` receives the raw response text for all configs. For tool-less configs (`direct`, `round-robin`), the response contains no tool call evidence and the judge will naturally score low — this is intentional and illustrates what the agentic scaffolding adds.

---

## Music Tasks (`tasks.ts`)

All tasks use the same small ABC-notation score as shared context:

```
X:1
T:Ode Fragment
M:4/4
K:C
|: C D E F | G4 | E D C2 | G,4 :|
```

| Task ID | Prompt summary | Ground truth |
|---|---|---|
| `transcribe` | Transcribe the score to readable notation (note names, durations, bar lines) | "Bar 1: C quarter, D quarter, E quarter, F quarter. Bar 2: G whole. Bar 3: E quarter, D quarter, C half. Bar 4: G, whole." |
| `find-composer` | The score is marked "after BWV 147 fragment, adapted". Identify the likely composer. | "Johann Sebastian Bach" |
| `generate` | Using only the notes C D E G A (pentatonic), compose an 8-bar melody in 4/4 time following classical conventions | "Bar 1: C E G E | Bar 2: A G E C | Bar 3: D E G A | Bar 4: G4 | Bar 5: E G A G | Bar 6: E D C2 | Bar 7: G A G E | Bar 8: C4" |
| `check-facts` | Given 5 statements about J.S. Bach (2 wrong: wrong birth year, wrong number of children), identify the incorrect ones | "Bach was born in 1675" and "Bach had 10 children" are incorrect |

---

## Configurations (`configs.ts`)

Each config is a `RunConfig` function `(task) => Promise<EvalResult>`.

### Token tracking for agent-based configs

`Agent.run()` returns `AgentResponse` (just `messages[]`) with no usage exposed. To capture token counts, `configs.ts` defines a small `TokenCountingMiddleware` that implements `BaseMiddleware`. Its `executeResponse` hook receives `ChatCompletionResult` (which has `usage`) and accumulates totals. Each config factory creates a fresh middleware instance per run and reads its accumulated counts after `agent.run()` completes.

### `single-agent`
`OpenAIAgent` with three music `FunctionTool` stubs:
- `lookup_composer(name)` → returns biographical stub
- `check_theory(question)` → returns music theory guidance stub  
- `transcribe_notation(abc)` → returns transcription guidance stub

Uses `TokenCountingMiddleware` to capture usage.

### `round-robin`
`RoundRobinOrchestrator` with two agents:
- `MusicAnalyst` — analyze musical content
- `MusicCritic` — critique and refine the analysis

Termination: `MaxMessageTermination(4)`. Final answer: last assistant message.

### `ai-orchestrated`
`AIOrchestrator` with the same two agents and same termination. The orchestrator's model client selects which agent runs each turn.

### `direct`
Raw `OpenAIChatClient.create()` — single user message, no system prompt, no tools, no retries. Usage captured directly from `ChatCompletionResult.usage`.

---

## Report Rendering (`report.ts`)

`renderReport(results: EvalResult[]): string` returns a complete self-contained HTML page.

**Structure:**
1. Page title + summary stats (total tasks run, configs evaluated, date)
2. **Graph 1 — Overall performance:** horizontal bar chart. Y-axis: config names. X-axis: average score (0–10) across all tasks.
3. **Graph 2 — Token efficiency by task:** grouped bar chart. X-axis: task IDs. Y-axis: score per 1000 tokens. One bar group per task, bars colored by config.
4. **Graph 3 — Performance by individual task:** grouped bar chart. X-axis: task IDs. Y-axis: average judge score (0–10). One bar group per task, bars colored by config.
5. **Detail table:** every `EvalResult` row with columns: config, task, avg score, tokens, score/1k tokens, and one column per judge.

**Technical:**
- Chart.js loaded from CDN (`https://cdn.jsdelivr.net/npm/chart.js`)
- All data embedded inline as a JS `const data = {...}` block
- No external fonts or stylesheets beyond a minimal inline `<style>`

---

## Entrypoint Flow (`index.ts`)

```
1. Load .env (OPENAI_API_KEY)
2. Instantiate judges: [ReasoningJudge, VerificationJudge, PlanningJudge, ToolUseJudge]
3. For each config in [single-agent, round-robin, ai-orchestrated, direct]:
     For each task in [transcribe, find-composer, generate, check-facts]:
       a. Run config(task) → EvalResult (with response + usage)
       b. For each judge: judge(task, result.response) → JudgeScore
       c. Attach judgeScores, compute averageScore + scorePerThousandTokens
       d. Log progress to console
4. renderReport(allResults) → write to src/exercises/music-eval/report.html
5. Log: "Report written to src/exercises/music-eval/report.html"
```

---

## Constraints

- Run sequentially — no `Promise.all` across configs/tasks, to avoid rate limiting
- Chart.js from CDN only — no npm chart dependencies
- Token usage for `single-agent` and orchestrated configs may be approximate (dependent on what `AgentResponse` exposes); document this in a comment
- All judge model calls use `gpt-4o-mini` (same model as agents) to keep costs low
