#!/usr/bin/env node
/**
 * npm downloads chart -> SVG.
 *
 * Fetches the npm registry's per-day download counts and renders a small
 * self-contained SVG (no dependencies, no third-party chart service) so the
 * README can show a curve that lives in the repository and cannot rot.
 *
 * usage:
 *   node scripts/npm-downloads-chart.mjs [--package <name>] [--days 90] [--out <path>] [--solo]
 *
 * drawing:
 *   the 7-day average is the主线 (solid, filled underneath) and the daily
 *   counts sit on top as a faint line: the day-to-day spikes are noisy, the
 *   average is what actually shows "we are at a few hundred a day". `--solo`
 *   drops the daily line entirely for a plain trend curve.
 *
 * notes:
 *   - the npm downloads API lags 2-3 days, so the tail of the curve is
 *     "two days ago", not today;
 *   - npm reports not-yet-settled days as 0, and the days before the first
 *     publish are 0 as well, so both ends are trimmed before drawing;
 *   - text is English on purpose: GitHub renders the SVG with the viewer's
 *     fonts, and English labels survive every locale;
 *   - the SVG paints an opaque background and ships both colour schemes,
 *     because an <img> SVG is its own document: `prefers-color-scheme` inside
 *     it follows the reader's system, not the theme they picked on GitHub.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const pkg = arg('package', '@kanadego/dsh-heartbeat');
const days = Math.max(7, Number(arg('days', 90)) || 90);
const out = resolve(arg('out', 'docs/assets/npm-downloads.svg'));
const solo = argv.includes('--solo');
const maWindow = 7;

const iso = (d) => d.toISOString().slice(0, 10);
const DAY = 86_400_000;
const endDate = new Date();
const startDate = new Date(endDate.getTime() - (days - 1) * DAY);
const api = `https://api.npmjs.org/downloads/range/${iso(startDate)}:${iso(endDate)}/${pkg}`;

const res = await fetch(api, { headers: { 'user-agent': 'dsh-heartbeat-downloads-chart' } });
if (!res.ok) throw new Error(`npm api replied ${res.status} for ${api}`);
const body = await res.json();

const series = (body?.downloads ?? [])
  .filter((d) => d && typeof d.downloads === 'number' && typeof d.day === 'string')
  .map((d) => ({ day: d.day, value: d.downloads }));
if (series.length < 2) throw new Error(`npm api returned ${series.length} usable day(s)`);

// A trailing zero is almost always "not settled yet" rather than "nobody
// installed it": it drags the right end of the curve into the floor. Leading
// zeros are the days before the first publish. Drop both; keep interior zeros.
let droppedTail = 0;
while (series.length > 2 && droppedTail < 3 && series[series.length - 1].value === 0) {
  series.pop();
  droppedTail += 1;
}
let droppedHead = 0;
while (series.length > 2 && series[0].value === 0) {
  series.shift();
  droppedHead += 1;
}

const total = series.reduce((sum, p) => sum + p.value, 0);
const peak = Math.max(...series.map((p) => p.value));
const last = series[series.length - 1];

/** Round an axis ceiling up to a readable number (1/2/2.5/5 x 10^n). */
function niceCeil(value) {
  if (value <= 0) return 10;
  const step = 10 ** Math.floor(Math.log10(value));
  for (const mult of [1, 2, 2.5, 5, 10]) {
    if (value <= mult * step) return mult * step;
  }
  return 10 * step;
}

const W = 820;
const H = 300;
const M = { l: 58, r: 28, t: 52, b: 40 };
const iw = W - M.l - M.r;
const ih = H - M.t - M.b;
const yMax = niceCeil(peak);

const x = (i) => M.l + (i / (series.length - 1)) * iw;
const y = (v) => M.t + ih - (v / yMax) * ih;
const pathOf = (pts) =>
  pts.map(([i, v], k) => `${k === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

const dailyPath = pathOf(series.map((p, i) => [i, p.value]));

const movingAverage = series.map((_, i) => {
  const from = Math.max(0, i - maWindow + 1);
  const slice = series.slice(from, i + 1);
  return slice.reduce((sum, p) => sum + p.value, 0) / slice.length;
});
const hasAverage = series.length >= maWindow;
// The average needs `maWindow` points to start, so it is drawn from the 7th day
// on; the area fill uses its full-length version so the left edge stays closed.
const averagePath = hasAverage ? pathOf(movingAverage.slice(maWindow - 1).map((v, k) => [k + maWindow - 1, v])) : '';
const areaBase = hasAverage ? pathOf(movingAverage.map((v, i) => [i, v])) : dailyPath;
const area = `${areaBase} L${x(series.length - 1).toFixed(1)},${(M.t + ih).toFixed(1)} L${M.l.toFixed(1)},${(M.t + ih).toFixed(1)} Z`;

const gridRows = [0, 0.25, 0.5, 0.75, 1].map((frac) => {
  const value = yMax * frac;
  const yy = y(value);
  return `  <line x1="${M.l}" y1="${yy.toFixed(1)}" x2="${(M.l + iw).toFixed(1)}" y2="${yy.toFixed(1)}" class="grid"/>
  <text x="${M.l - 10}" y="${(yy + 4).toFixed(1)}" class="tick" text-anchor="end">${Math.round(value).toLocaleString('en-US')}</text>`;
});

const tickEvery = Math.max(1, Math.round(series.length / 6));
const xTicks = series
  .map((p, i) => ({ p, i }))
  .filter(({ i }) => i % tickEvery === 0 || i === series.length - 1)
  .map(({ p, i }) => {
    const label = p.day.slice(5); // MM-DD
    const anchor = i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle';
    return `  <text x="${x(i).toFixed(1)}" y="${(M.t + ih + 22).toFixed(1)}" class="tick" text-anchor="${anchor}">${label}</text>`;
  });

const lastX = x(series.length - 1);
const lastY = y(last.value);
const peakIdx = series.findIndex((p) => p.value === peak);
const peakX = x(peakIdx);
const peakY = y(peak);

// Legend mirrors the drawing: a faint stub for the daily line (omitted in
// --solo mode), a solid one for the average.
const legendItems = [];
if (!solo) legendItems.push(['legend-dim', 'daily']);
if (hasAverage) legendItems.push(['legend-line', `${maWindow}-day avg`]);
const legend = legendItems
  .map(([cls, label], k) => {
    const x1 = W - M.r - 176 + k * 96;
    return `  <line x1="${x1}" y1="20" x2="${x1 + 20}" y2="20" class="${cls}"/>
  <text x="${x1 + 26}" y="24" class="sub">${label}</text>`;
  })
  .join('\n');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="npm downloads per day for ${pkg}">
<title>npm downloads per day - ${pkg}</title>
<style>
  :root { --bg:#ffffff; --fg:#334155; --dim:#7c8ba1; --grid:#e6ebf2; --axis:#c8d2e0; --line:#e0a03a; --line2:#f2c879; --daily:rgba(224,160,58,.55); --fill:rgba(224,160,58,.18); }
  @media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --fg:#d7dee9; --dim:#8b9bb0; --grid:#242c3a; --axis:#39424f; --line:#f0b552; --line2:#ffd894; --daily:rgba(240,181,82,.50); --fill:rgba(240,181,82,.20); } }
  text { font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .title { font-size: 15px; font-weight: 600; fill: var(--fg); }
  .sub { font-size: 12px; fill: var(--dim); }
  .tick { font-size: 11px; fill: var(--dim); }
  .grid { stroke: var(--grid); stroke-width: 1; }
  .axis { stroke: var(--axis); stroke-width: 1; }
  .line { fill: none; stroke: var(--daily); stroke-width: 1.4; stroke-linejoin: round; stroke-linecap: round; }
  .ma { fill: none; stroke: url(#stroke); stroke-width: 2.6; stroke-linejoin: round; stroke-linecap: round; }
  .legend-dim { fill: none; stroke: var(--daily); stroke-width: 2.6; stroke-linecap: round; }
  .legend-line { fill: none; stroke: var(--line); stroke-width: 2.6; stroke-linecap: round; }
  .area { fill: url(#fill); }
  .dot { fill: var(--line); }
  .dot-dim { fill: var(--daily); }
</style>
<defs>
  <linearGradient id="stroke" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0%" style="stop-color:var(--line)"/>
    <stop offset="100%" style="stop-color:var(--line2)"/>
  </linearGradient>
  <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" style="stop-color:var(--fill)"/>
    <stop offset="100%" style="stop-color:transparent"/>
  </linearGradient>
</defs>
<rect x="0" y="0" width="${W}" height="${H}" fill="var(--bg)"/>
<text x="${M.l}" y="24" class="title">npm downloads / day</text>
<text x="${M.l}" y="42" class="sub">${pkg} · ${series.length} days · total ${total.toLocaleString('en-US')} · peak ${peak.toLocaleString('en-US')} · updated ${last.day}</text>
${legend}
${gridRows.join('\n')}
<line x1="${M.l}" y1="${(M.t + ih).toFixed(1)}" x2="${(M.l + iw).toFixed(1)}" y2="${(M.t + ih).toFixed(1)}" class="axis"/>
<path d="${area}" class="area"/>
${hasAverage ? `<path d="${averagePath}" class="ma"/>` : ''}
${solo ? '' : `<path d="${dailyPath}" class="line"/>`}
<circle cx="${peakX.toFixed(1)}" cy="${peakY.toFixed(1)}" r="3" class="dot-dim"/>
<circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="4.5" class="dot"/>
<text x="${(lastX - 8).toFixed(1)}" y="${(lastY - 12).toFixed(1)}" class="sub" text-anchor="end">${last.value.toLocaleString('en-US')}</text>
${xTicks.join('\n')}
</svg>
`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, svg, 'utf8');
console.log(
  `npm-downloads-chart: ${pkg} · ${series.length} days (head -${droppedHead}, tail -${droppedTail}) · total ${total} · peak ${peak} · tail ${last.day}=${last.value}${solo ? ' · solo (average only)' : ''}`,
);
console.log(`npm-downloads-chart: wrote ${out} (${Buffer.byteLength(svg, 'utf8')} bytes)`);
