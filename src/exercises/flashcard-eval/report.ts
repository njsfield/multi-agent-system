import type { EvalResult } from './types';

export function renderReport(results: EvalResult[]): string {
  const date = new Date().toISOString().split('T')[0]!;
  const judgeNames = results[0]?.judgeScores.map(j => j.judgeName) ?? [];

  const tableRows = results.map(r => `
    <tr>
      <td>${r.scenarioId}</td>
      <td>${r.scenarioDescription}</td>
      <td>${r.selectedCardId ?? 'null'}</td>
      <td><strong>${r.averageScore.toFixed(1)}</strong></td>
      ${r.judgeScores.map(j => `<td title="${j.justification.replace(/"/g, '&quot;')}">${j.score}</td>`).join('')}
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Flashcard Eval — ${date}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 960px; margin: 2rem auto; padding: 0 1rem; }
    h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
    canvas { max-height: 280px; margin-bottom: 2rem; }
    table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
    th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; }
    th { background: #f5f5f5; }
  </style>
</head>
<body>
  <h1>Flashcard Selection Eval — ${date}</h1>
  <p>${results.length} scenarios · ${judgeNames.length} judges</p>
  <h2>Average Score by Scenario</h2>
  <canvas id="chart1"></canvas>
  <h2>Score per Judge by Scenario</h2>
  <canvas id="chart2"></canvas>
  <h2>Detail (hover score cells for justification)</h2>
  <table>
    <thead><tr>
      <th>Scenario</th><th>Description</th><th>Selected ID</th><th>Avg</th>
      ${judgeNames.map(j => `<th>${j}</th>`).join('')}
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
