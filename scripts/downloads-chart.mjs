/**
 * Render assets/downloads-light.svg and assets/downloads-dark.svg: the
 * download trend chart the README shows. Run by .github/workflows/
 * downloads-chart.yml on a schedule; safe to run by hand.
 *
 * Two sources, two honesty levels:
 *
 * - npm publishes a real daily time-series (api.npmjs.org/downloads/range),
 *   so the CLI bars are historical fact from the first publish onward.
 * - Open VSX exposes only the CURRENT total (downloadCount). There is no
 *   history endpoint, so this script snapshots the total into
 *   assets/downloads-data.json on every run, and the extension line is drawn
 *   from those snapshots: it grows a point per day, starting the day this
 *   chart shipped. A line we did not observe is not a line we draw.
 *
 * Zero dependencies, same as everything else in this repo.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "assets", "downloads-data.json");
const NPM_PKG = "lodestone-cli";
const OVSX = "VedantShirgaonkar/lodestone";
const FIRST_PUBLISH = "2026-07-13";

const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "lodestone-chart" } });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

async function npmDaily() {
  // The range endpoint caps at 18 months per request; the project is younger.
  const to = utcDay();
  const json = await fetchJson(
    `https://api.npmjs.org/downloads/range/${FIRST_PUBLISH}:${to}/${NPM_PKG}`
  );
  return (json.downloads ?? []).map((d) => ({ day: d.day, count: d.downloads }));
}

async function openVsxTotal() {
  const json = await fetchJson(`https://open-vsx.org/api/${OVSX}`);
  return typeof json.downloadCount === "number" ? json.downloadCount : undefined;
}

function loadSnapshots() {
  if (!existsSync(DATA)) return [];
  try {
    return JSON.parse(readFileSync(DATA, "utf8"));
  } catch {
    return [];
  }
}

function saveSnapshot(snapshots, total) {
  const today = utcDay();
  const rest = snapshots.filter((s) => s.day !== today);
  rest.push({ day: today, openvsx_total: total });
  rest.sort((a, b) => (a.day < b.day ? -1 : 1));
  writeFileSync(DATA, JSON.stringify(rest, null, 2) + "\n", "utf8");
  return rest;
}

/** Minimal sparkline SVG: npm daily bars, extension total line above them. */
function renderSvg({ bars, line, dark }) {
  const W = 720;
  const H = 150;
  const PAD = { l: 10, r: 10, t: 30, b: 24 };
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;

  const ink = dark ? "#e6e6e6" : "#1f2328";
  const faint = dark ? "#9198a1" : "#59636e";
  const barFrom = "#7c6cba"; // brand violet
  const barTo = "#4ad6f0"; // brand cyan

  const days = bars.map((b) => b.day);
  const n = Math.max(days.length, 1);
  const maxBar = Math.max(...bars.map((b) => b.count), 1);
  const maxLine = Math.max(...line.map((p) => p.total), 1);

  const x = (i) => PAD.l + (plotW * (i + 0.5)) / n;
  const barW = Math.min(26, (plotW / n) * 0.55);

  let rects = "";
  bars.forEach((b, i) => {
    const h = Math.max(2, (b.count / maxBar) * (plotH * 0.9));
    rects += `<rect x="${(x(i) - barW / 2).toFixed(1)}" y="${(PAD.t + plotH - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="url(#g)" opacity="0.9"/>`;
  });

  // Extension line: plotted against its own scale so early days still show.
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const pts = line
    .filter((p) => dayIndex.has(p.day))
    .map((p) => `${x(dayIndex.get(p.day)).toFixed(1)},${(PAD.t + plotH - (p.total / maxLine) * (plotH * 0.9)).toFixed(1)}`);
  const path =
    pts.length >= 2
      ? `<polyline points="${pts.join(" ")}" fill="none" stroke="${barTo}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`
      : pts.length === 1
        ? `<circle cx="${pts[0].split(",")[0]}" cy="${pts[0].split(",")[1]}" r="3.5" fill="${barTo}"/>`
        : "";

  const lastBar = bars[bars.length - 1];
  const lastTotal = line[line.length - 1];
  const asOf = utcDay();

  const label = (t, xx, anchor = "start", fill = faint, size = 11, weight = "400") =>
    `<text x="${xx}" y="18" font-family="ui-sans-serif,system-ui,sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${t}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="lodestone downloads over time">
  <defs>
    <linearGradient id="g" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="${barFrom}"/>
      <stop offset="1" stop-color="${barTo}"/>
    </linearGradient>
  </defs>
  ${label("downloads", PAD.l, "start", ink, 12, "600")}
  ${label(`▮ npm / day${lastBar ? ` (${lastBar.count} on ${lastBar.day.slice(5)})` : ""}`, 110)}
  ${label(`— extension total${lastTotal ? ` (${lastTotal.total})` : ""}`, 320)}
  ${label(`updates daily · ${asOf}`, W - PAD.r, "end")}
  ${rects}
  ${path}
</svg>
`;
}

const bars = await npmDaily();
const total = await openVsxTotal();
const snapshots = total !== undefined ? saveSnapshot(loadSnapshots(), total) : loadSnapshots();
const line = snapshots.map((s) => ({ day: s.day, total: s.openvsx_total }));

mkdirSync(join(ROOT, "assets"), { recursive: true });
writeFileSync(join(ROOT, "assets", "downloads-light.svg"), renderSvg({ bars, line, dark: false }), "utf8");
writeFileSync(join(ROOT, "assets", "downloads-dark.svg"), renderSvg({ bars, line, dark: true }), "utf8");
console.log(
  `chart: ${bars.length} npm day(s), extension total ${total ?? "unavailable"}, ${line.length} snapshot(s)`
);
