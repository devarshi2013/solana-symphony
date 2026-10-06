import { TOKEN_SYMBOLS, type Strategy } from "@solana-symphony/dsl";
import type { LabeledResult } from "./benchmark.js";
import type { Comparison } from "./compare.js";

/** Chart.js UMD bundle, pinned with a subresource-integrity hash. */
export const CHART_JS_URL = "https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js";
export const CHART_JS_INTEGRITY =
  "sha384-jb8JQMbMoBUzgWatfe6COACi2ljcDdZQ2OxczGA3bGNeWe+6DChMTBJemed7ZnvJ";

export interface ReportInput {
  strategy: Strategy;
  /** Plain-English description from the dsl's describe(). */
  description: string;
  /** Strategy first, then benchmarks, as passed to compare(). */
  results: readonly LabeledResult[];
  comparison: Comparison;
  settings: { start: string; end: string; capital: number; feeBps: number; slippageBps: number };
  generatedAt: string;
}

/** Drawdown at each point as a fraction below the running peak (0 or negative). */
export function drawdownSeries(
  equityCurve: ReadonlyArray<{ value: number }>,
  initialCapital: number,
): number[] {
  let peak = initialCapital;
  return equityCurve.map(({ value }) => {
    peak = Math.max(peak, value);
    return value / peak - 1;
  });
}

/**
 * Renders a standalone HTML report: metrics table, equity curve vs benchmarks, drawdowns,
 * and the strategy's allocation over time. Charts load Chart.js from a CDN; everything
 * else, including the data, is inline.
 */
export function renderReport(input: ReportInput): string {
  const { strategy, results, comparison, settings } = input;
  const strategyResult = results[0]!.result;
  const dates = strategyResult.equityCurve.map((p) => p.date);

  // Allocation series in registry order, so each token keeps the same color in every report.
  const held = new Set(strategyResult.holdings.flatMap((h) => Object.keys(h.weights)));
  const allocationSymbols = [
    ...TOKEN_SYMBOLS.filter((s) => held.has(s)),
    ...[...held].filter((s) => !(TOKEN_SYMBOLS as readonly string[]).includes(s)).sort(),
  ];
  const data = {
    dates,
    series: results.map((r) => ({
      label: r.label,
      equity: r.result.equityCurve.map((p) => round(p.value, 2)),
      drawdown: drawdownSeries(r.result.equityCurve, r.result.initialCapital).map((d) =>
        round(d, 6),
      ),
    })),
    allocation: allocationSymbols.map((symbol) => ({
      symbol,
      slot: tokenSlot(symbol),
      weights: strategyResult.holdings.map((h) => round(h.weights[symbol] ?? 0, 6)),
    })),
  };

  const lastHoldings = strategyResult.holdings.at(-1)?.weights ?? {};
  const warnings = results.flatMap((r) => r.result.warnings.map((w) => `${r.label}: ${w}`));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(strategy.name)} · backtest</title>
<style>${STYLES}</style>
</head>
<body>
<main class="viz-root">
  <header>
    <h1>${esc(strategy.name)}</h1>
    ${strategy.description ? `<p class="lede">${esc(strategy.description)}</p>` : ""}
    <p class="meta">${esc(settings.start)} to ${esc(settings.end)} · starting capital ${esc(money(settings.capital))} USDC · fee ${settings.feeBps} bps · slippage ${settings.slippageBps} bps · generated ${esc(input.generatedAt)}</p>
  </header>

  <section>
    <h2>Metrics</h2>
    <div class="table-wrap">
      <table class="metrics">
        <thead><tr><th></th>${comparison.labels.map((l) => `<th>${esc(l)}</th>`).join("")}</tr></thead>
        <tbody>
${comparison.rows.map((r) => `          <tr><th>${esc(r.metric)}</th>${r.cells.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("\n")}
        </tbody>
      </table>
    </div>
  </section>

  <section>
    <h2>Equity (USDC)</h2>
    <div class="chart"><canvas id="equity" role="img" aria-label="Portfolio value over time for ${esc(comparison.labels.join(", "))}"></canvas></div>
  </section>

  <section>
    <h2>Drawdown from peak</h2>
    <div class="chart short"><canvas id="drawdown" role="img" aria-label="Drawdown from running peak over time"></canvas></div>
  </section>

  <section>
    <h2>Allocation over time: ${esc(strategy.name)}</h2>
    <div class="chart"><canvas id="allocation" role="img" aria-label="Share of portfolio held in each token over time"></canvas></div>
    <h3>Allocation on ${esc(dates.at(-1) ?? "-")}</h3>
    <table class="compact">
      <tbody>
${Object.entries(lastHoldings)
  .map(
    ([s, w]) =>
      `        <tr><th><span class="swatch" style="background:var(--series-${tokenSlot(s)})"></span>${esc(s)}</th><td>${(w * 100).toFixed(1)}%</td></tr>`,
  )
  .join("\n")}
      </tbody>
    </table>
  </section>

  <section>
    <h2>Strategy</h2>
    <pre>${esc(input.description)}</pre>
  </section>
${
  warnings.length > 0
    ? `
  <section>
    <h2>Warnings (${warnings.length})</h2>
    <ul class="warnings">${warnings
      .slice(0, 50)
      .map((w) => `<li>${esc(w)}</li>`)
      .join(
        "",
      )}${warnings.length > 50 ? `<li>…and ${warnings.length - 50} more (see results.json)</li>` : ""}</ul>
  </section>`
    : ""
}
  <p id="offline" class="meta" hidden>Charts could not load (Chart.js comes from ${esc(CHART_JS_URL)}; check your internet connection). The tables above are complete.</p>
</main>
<script src="${CHART_JS_URL}" integrity="${CHART_JS_INTEGRITY}" crossorigin="anonymous"></script>
<script id="report-data" type="application/json">${jsonForScript(data)}</script>
<script>${CHART_SCRIPT}</script>
</body>
</html>
`;
}

/** Categorical slot (1-8) for a token: its position in the registry. */
function tokenSlot(symbol: string): number {
  const i = (TOKEN_SYMBOLS as readonly string[]).indexOf(symbol);
  return i === -1 ? 8 : (i % 8) + 1;
}

function esc(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** JSON safe to embed in a <script> element: `<` can never close the tag. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function money(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// Palette: the dataviz skill's validated reference palette, light and dark steps.
const STYLES = `
.viz-root {
  color-scheme: light;
  --page: #f9f9f7; --surface-1: #fcfcfb; --text-primary: #0b0b0b; --text-secondary: #52514e;
  --muted: #898781; --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10);
  --series-1: #2a78d6; --series-2: #eb6834; --series-3: #1baf7a; --series-4: #eda100;
  --series-5: #e87ba4; --series-6: #008300; --series-7: #4a3aa7; --series-8: #e34948;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) .viz-root {
    color-scheme: dark;
    --page: #0d0d0d; --surface-1: #1a1a19; --text-primary: #ffffff; --text-secondary: #c3c2b7;
    --muted: #898781; --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
    --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70; --series-4: #c98500;
    --series-5: #d55181; --series-6: #008300; --series-7: #9085e9; --series-8: #e66767;
  }
}
:root[data-theme="dark"] .viz-root {
  color-scheme: dark;
  --page: #0d0d0d; --surface-1: #1a1a19; --text-primary: #ffffff; --text-secondary: #c3c2b7;
  --muted: #898781; --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
  --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70; --series-4: #c98500;
  --series-5: #d55181; --series-6: #008300; --series-7: #9085e9; --series-8: #e66767;
}
html, body { margin: 0; }
body { background: #f9f9f7; }
@media (prefers-color-scheme: dark) { body { background: #0d0d0d; } }
.viz-root {
  background: var(--page); color: var(--text-primary); min-height: 100vh; box-sizing: border-box;
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  padding: 24px clamp(16px, 4vw, 48px) 48px; max-width: 1200px; margin: 0 auto;
}
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 0 0 12px; }
h3 { font-size: 13px; margin: 16px 0 8px; color: var(--text-secondary); font-weight: 600; }
.lede { margin: 0 0 4px; color: var(--text-secondary); }
.meta { margin: 0; color: var(--muted); font-size: 12px; }
section {
  background: var(--surface-1); border: 1px solid var(--border); border-radius: 8px;
  padding: 16px; margin-top: 16px;
}
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; font-variant-numeric: tabular-nums; }
.metrics { width: 100%; }
th, td { padding: 4px 12px; border-bottom: 1px solid var(--grid); white-space: nowrap; }
thead th { text-align: right; color: var(--text-secondary); font-weight: 600; }
tbody th { text-align: left; font-weight: 400; color: var(--text-secondary); }
td { text-align: right; }
.compact td { min-width: 64px; }
.swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 8px; vertical-align: -1px; }
.chart { position: relative; height: 360px; }
.chart.short { height: 240px; }
pre { margin: 0; white-space: pre-wrap; font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--text-secondary); }
.warnings { margin: 0; padding-left: 20px; color: var(--text-secondary); font-size: 13px; }
`;

const CHART_SCRIPT = `
(function () {
  if (typeof Chart === "undefined") {
    document.getElementById("offline").hidden = false;
    return;
  }
  var data = JSON.parse(document.getElementById("report-data").textContent);
  var root = document.querySelector(".viz-root");
  var css = function (name) { return getComputedStyle(root).getPropertyValue(name).trim(); };
  var pct = function (v) { return (v * 100).toFixed(1) + "%"; };
  var usd = function (v) { return v.toLocaleString("en-US", { maximumFractionDigits: 0 }); };
  var charts = [];

  function base(yFormat, extra) {
    return Object.assign({
      animation: false,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      elements: { point: { radius: 0, hoverRadius: 4, hitRadius: 8 }, line: { borderWidth: 2, tension: 0 } },
      plugins: {
        legend: { position: "top", align: "start", labels: { color: css("--text-secondary"), boxWidth: 12, boxHeight: 12, useBorderRadius: true, borderRadius: 2 } },
        tooltip: { callbacks: { label: function (c) { return " " + c.dataset.label + ": " + yFormat(c.parsed.y); } } }
      },
      scales: {
        x: { ticks: { color: css("--muted"), maxTicksLimit: 8, maxRotation: 0 }, grid: { display: false }, border: { color: css("--axis") } },
        y: { ticks: { color: css("--muted"), callback: yFormat }, grid: { color: css("--grid") }, border: { display: false } }
      }
    }, extra || {});
  }

  function draw() {
    charts.forEach(function (c) { c.destroy(); });
    charts = [];
    var surface = css("--surface-1");

    charts.push(new Chart(document.getElementById("equity"), {
      type: "line",
      data: { labels: data.dates, datasets: data.series.map(function (s, i) {
        return { label: s.label, data: s.equity, borderColor: css("--series-" + (i + 1)), backgroundColor: css("--series-" + (i + 1)) };
      }) },
      options: base(usd)
    }));

    charts.push(new Chart(document.getElementById("drawdown"), {
      type: "line",
      data: { labels: data.dates, datasets: data.series.map(function (s, i) {
        return { label: s.label, data: s.drawdown, borderColor: css("--series-" + (i + 1)), backgroundColor: css("--series-" + (i + 1)) };
      }) },
      options: base(pct, undefined)
    }));
    charts[1].options.scales.y.max = 0;
    charts[1].update();

    var allocation = base(pct);
    allocation.scales.y.stacked = true;
    allocation.scales.y.min = 0;
    allocation.scales.y.max = 1;
    allocation.elements.line.borderWidth = 1;
    charts.push(new Chart(document.getElementById("allocation"), {
      type: "line",
      data: { labels: data.dates, datasets: data.allocation.map(function (a, i) {
        var color = css("--series-" + a.slot);
        return { label: a.symbol, data: a.weights, fill: i === 0 ? "origin" : "-1", backgroundColor: color, borderColor: surface, stepped: true };
      }) },
      options: allocation
    }));
  }

  draw();
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", draw);
  }
})();
`;
