import path from "path";
import fs from "fs";
import { OpenAIChatClient } from "./client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JudgeScore {
  judgeName: string;
  score: number;
  justification: string;
}

export interface EvalResult {
  scenarioId: string;
  description: string;
  expectedBehavior: string;
  agentResponse: string;
  judgeScores: JudgeScore[];
  averageScore: number;
}

export interface Scenario {
  id: string;
  description: string;
  expectedBehavior: string;
}

// ---------------------------------------------------------------------------
// LLM Judge
// ---------------------------------------------------------------------------

export abstract class LLMJudge {
  protected client = new OpenAIChatClient("gpt-4o-mini");
  abstract criteriaPrompt: string;

  get judgeName(): string {
    return this.constructor.name;
  }

  async judge(evalContext: string, agentResponse: string): Promise<JudgeScore> {
    const result = await this.client.create([
      {
        role: "system",
        content:
          "You are an impartial evaluator for an AI agent. Score 0–10. Respond with JSON only: {\"score\": number, \"justification\": string}",
        source: "system",
        timestamp: new Date(),
      },
      {
        role: "user",
        content: `${this.criteriaPrompt}\n\n${evalContext}\n\nAgent response:\n${agentResponse}`,
        source: "user",
        timestamp: new Date(),
      },
    ]);

    try {
      const parsed = JSON.parse(result.message.content) as {
        score: number;
        justification: string;
      };
      return {
        judgeName: this.judgeName,
        score: parsed.score,
        justification: parsed.justification,
      };
    } catch {
      return {
        judgeName: this.judgeName,
        score: 0,
        justification: "Failed to parse judge response",
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Report renderer
// ---------------------------------------------------------------------------

export function renderReport(results: EvalResult[], title: string): string {
  const date = new Date().toISOString().split("T")[0]!;
  const judgeNames = results[0]?.judgeScores.map((j) => j.judgeName) ?? [];

  const tableRows = results
    .map(
      (r) => `
    <tr>
      <td>${r.scenarioId}</td>
      <td>${r.description}</td>
      <td><code>${r.agentResponse.slice(0, 120).replace(/</g, "&lt;")}${r.agentResponse.length > 120 ? "…" : ""}</code></td>
      <td><strong>${r.averageScore.toFixed(1)}</strong></td>
      ${r.judgeScores
        .map(
          (j) =>
            `<td title="${j.justification.replace(/"/g, "&quot;")}">${j.score}</td>`,
        )
        .join("")}
    </tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title} — ${date}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 1100px; margin: 2rem auto; padding: 0 1rem; }
    h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
    canvas { max-height: 280px; margin-bottom: 2rem; }
    table { border-collapse: collapse; width: 100%; font-size: 0.83rem; }
    th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; vertical-align: top; }
    th { background: #f5f5f5; }
    code { font-size: 0.78rem; background: #f0f0f0; padding: 2px 4px; border-radius: 3px; }
  </style>
</head>
<body>
  <h1>${title} — ${date}</h1>
  <p>${results.length} scenarios · ${judgeNames.length} judges</p>
  <h2>Average Score by Scenario</h2>
  <canvas id="chart1"></canvas>
  <h2>Score per Judge by Scenario</h2>
  <canvas id="chart2"></canvas>
  <h2>Detail (hover score cells for judge justification)</h2>
  <table>
    <thead><tr>
      <th>Scenario</th><th>Description</th><th>Agent Response</th><th>Avg</th>
      ${judgeNames.map((j) => `<th>${j}</th>`).join("")}
    </tr></thead>
    <tbody>${tableRows}</tbody>
  </table>
  <script>
    const d = ${JSON.stringify({ results, judgeNames })};
    const colors = ['#3b82f6','#22c55e','#f97316','#a855f7','#06b6d4'];
    new Chart(document.getElementById('chart1'), {
      type: 'bar',
      data: {
        labels: d.results.map(r => r.scenarioId),
        datasets: [{ label: 'Avg Score', data: d.results.map(r => r.averageScore), backgroundColor: '#3b82f6' }],
      },
      options: { scales: { y: { min: 0, max: 10 } } },
    });
    new Chart(document.getElementById('chart2'), {
      type: 'bar',
      data: {
        labels: d.results.map(r => r.scenarioId),
        datasets: d.judgeNames.map((name, i) => ({
          label: name,
          data: d.results.map(r => r.judgeScores[i].score),
          backgroundColor: colors[i % colors.length],
        })),
      },
      options: { scales: { y: { min: 0, max: 10 } } },
    });
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Generic eval runner
// ---------------------------------------------------------------------------

export async function runEval<S extends Scenario>(opts: {
  agentName: string;
  scenarios: S[];
  judges: LLMJudge[];
  run: (scenario: S) => Promise<string>;
  buildContext: (scenario: S) => string;
  outputDir: string;
}): Promise<void> {
  const { agentName, scenarios, judges, run, buildContext, outputDir } = opts;
  const results: EvalResult[] = [];

  for (const scenario of scenarios) {
    console.log(`\n[${agentName}] Scenario: ${scenario.id}`);
    const agentResponse = await run(scenario);
    console.log(`  Response: ${agentResponse.slice(0, 120)}`);

    const evalContext = buildContext(scenario);
    const judgeScores: JudgeScore[] = [];
    for (const judge of judges) {
      const score = await judge.judge(evalContext, agentResponse);
      console.log(`  ${score.judgeName}: ${score.score}/10 — ${score.justification.slice(0, 80)}`);
      judgeScores.push(score);
    }

    const averageScore =
      judgeScores.reduce((sum, j) => sum + j.score, 0) / judgeScores.length;

    results.push({
      scenarioId: scenario.id,
      description: scenario.description,
      expectedBehavior: scenario.expectedBehavior,
      agentResponse,
      judgeScores,
      averageScore,
    });
  }

  const overall = results.reduce((s, r) => s + r.averageScore, 0) / results.length;
  console.log(`\n[${agentName}] Overall avg: ${overall.toFixed(2)}/10`);

  const html = renderReport(results, `${agentName} Eval`);
  const outPath = path.join(outputDir, `${agentName}.eval.html`);
  fs.writeFileSync(outPath, html);

  console.log(`\nReport: ${outPath}`);
  console.log("View in browser:");
  console.log(`  open ${outPath}`);
  console.log(`  # or on Linux:`);
  console.log(`  xdg-open ${outPath}`);
}
