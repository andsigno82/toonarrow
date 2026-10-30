/** Local dashboard served by the proxy at /_toonarrow/. Self-contained: inline CSS, SVG charts, data from api/summary. */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>toonarrow dashboard</title>
<style>
:root {
  --bg: #f6f4ee; --surface: #fffdf8; --ink: #1f1d18; --muted: #6d685d; --line: #e3ded2; --accent: #2d7a4b;
  --saved-skills: #2d7a4b; --saved-bash: #93c9a5;
  --u-input: #c5582f; --u-read: #2d7a4b; --u-write: #d8a23f; --u-output: #4b6fa6;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #151410; --surface: #1d1c17; --ink: #ebe7dc; --muted: #a29d90; --line: #34322a; --accent: #6cc28a;
    --saved-skills: #5bb57d; --saved-bash: #2f6b45;
    --u-input: #e07a52; --u-read: #5bb57d; --u-write: #e0b45a; --u-output: #7d9bd0;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
.mono, .label, th { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
.wrap { max-width: 1080px; margin: 0 auto; padding: 24px 16px 48px; }
header { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 24px; justify-content: space-between; padding-bottom: 16px; border-bottom: 1px solid var(--line); }
.brand { font-family: ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: .12em; text-transform: uppercase; font-size: 13px; }
.brand b { color: var(--accent); }
.range { display: flex; gap: 4px; }
.range button { font: 12px ui-monospace, Menlo, monospace; padding: 6px 10px; border: 1px solid var(--line); background: var(--surface); color: var(--muted); border-radius: 6px; cursor: pointer; }
.range button[aria-pressed="true"] { color: var(--ink); border-color: var(--ink); }
.updated { color: var(--muted); font-size: 12px; }
h1 { font-size: 22px; font-weight: 600; margin: 24px 0 4px; }
.sub { color: var(--muted); margin: 0 0 20px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); gap: 12px; margin-bottom: 16px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
.card.hero { border-color: var(--accent); }
.label { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.value { font-size: 28px; font-weight: 600; margin: 6px 0 2px; font-variant-numeric: tabular-nums; }
.hero .value { color: var(--accent); }
.note { font-size: 12px; color: var(--muted); }
.panel { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
.panel h2 { font-size: 15px; font-weight: 600; margin: 0 0 12px; }
svg { display: block; width: 100%; height: auto; }
svg text { fill: var(--muted); font: 10px ui-monospace, Menlo, monospace; }
svg .grid { stroke: var(--line); }
.legend { display: flex; flex-wrap: wrap; gap: 14px; justify-content: center; margin-top: 8px; font-size: 12px; color: var(--muted); }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th { font-size: 11px; font-weight: 500; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); text-align: right; padding: 6px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
td { padding: 7px 8px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
th:first-child, td:first-child, td.left, th.left { text-align: left; }
td.saved { color: var(--accent); font-weight: 600; }
tr:last-child td { border-bottom: 0; }
.cards > *, .panel { min-width: 0; }
td.multi { white-space: normal; min-width: 140px; }
.method { color: var(--muted); font-size: 12px; line-height: 1.6; }
.method code { font-size: 11px; }
.empty { color: var(--muted); padding: 24px 0; text-align: center; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="brand"><b>toonarrow</b> &nbsp;context compression proxy</div>
    <div class="range" role="group" aria-label="Periodo">
      <button data-days="1">oggi</button><button data-days="7">7 giorni</button><button data-days="30">30 giorni</button><button data-days="90">90 giorni</button>
    </div>
    <div class="updated" id="updated"></div>
  </header>

  <h1>Dashboard</h1>
  <p class="sub" id="sub"></p>

  <div class="cards">
    <div class="card hero"><div class="label">Token risparmiati (stima)</div><div class="value" id="c-saved">-</div><div class="note" id="c-saved-note"></div></div>
    <div class="card"><div class="label">Token di prompt inviati</div><div class="value" id="c-prompt">-</div><div class="note" id="c-prompt-note"></div></div>
    <div class="card"><div class="label">Cache hit</div><div class="value" id="c-hit">-</div><div class="note">cache read / token di prompt</div></div>
    <div class="card"><div class="label">Richieste</div><div class="value" id="c-req">-</div><div class="note" id="c-req-note"></div></div>
  </div>

  <div class="panel">
    <h2>Token risparmiati per giorno</h2>
    <svg id="chart-saved" viewBox="0 0 1000 240" role="img" aria-label="Token risparmiati per giorno"></svg>
    <div class="legend" id="legend-saved"></div>
  </div>

  <div class="panel">
    <h2>Token consumati per giorno</h2>
    <svg id="chart-usage" viewBox="0 0 1000 240" role="img" aria-label="Token consumati per giorno"></svg>
    <div class="legend" id="legend-usage"></div>
  </div>

  <div class="panel">
    <h2>Sessioni recenti</h2>
    <div class="table-wrap"><table id="t-sessions"></table></div>
  </div>

  <div class="panel"><h2>Per modello</h2><div class="table-wrap"><table id="t-models"></table></div></div>
  <div class="panel"><h2>Per client</h2><div class="table-wrap"><table id="t-clients"></table></div></div>

  <div class="panel method">
    <h2>Come sono calcolati</h2>
    I token consumati sono quelli dichiarati dal provider in ogni risposta, come in <code>toonarrow stats</code>: <code>input</code> esclude i token letti dalla cache.
    I token risparmiati sono una stima: per ogni richiesta riscritta, i caratteri tolti da toonarrow (descrizioni delle skill, output dei comandi shell)
    sono convertiti con la densità della richiesta stessa, cioè token di prompt fatturati diviso byte effettivamente inviati.
    Sono token che altrimenti sarebbero stati inviati in quella richiesta, in cache o no.
  </div>
</div>

<script>
const SAVED = [
  { key: 'savedSkills', label: 'Elenco skill', color: 'var(--saved-skills)' },
  { key: 'savedBash', label: 'Output shell', color: 'var(--saved-bash)' },
];
const USAGE = [
  { key: 'cacheRead', label: 'Cache read', color: 'var(--u-read)' },
  { key: 'cacheWrite', label: 'Cache write', color: 'var(--u-write)' },
  { key: 'input', label: 'Input', color: 'var(--u-input)' },
  { key: 'output', label: 'Output', color: 'var(--u-output)' },
];
const nf = new Intl.NumberFormat('it-IT');
const cf = new Intl.NumberFormat('it-IT', { notation: 'compact', maximumFractionDigits: 1 });
const saved = (t) => t.savedSkills + t.savedBash;
const prompt = (t) => t.input + t.cacheRead + t.cacheWrite;
const pf = new Intl.NumberFormat('it-IT', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
const hit = (t) => (prompt(t) ? pf.format(t.cacheRead / prompt(t)) : '-');
const dayLabel = (d) => new Date(d + 'T12:00:00').toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
const when = (ts) => new Date(ts).toLocaleString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const SVG = 'http://www.w3.org/2000/svg';

function el(tag, attrs, text) {
  const node = tag.startsWith('svg:') ? document.createElementNS(SVG, tag.slice(4)) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function stacked(svg, daily, series) {
  svg.replaceChildren();
  const W = 1000, H = 240, L = 56, R = 8, T = 10, B = 26;
  const max = niceMax(Math.max(0, ...daily.map((d) => series.reduce((s, x) => s + d[x.key], 0))));
  for (let i = 0; i <= 4; i++) {
    const y = T + ((H - T - B) * i) / 4;
    svg.append(el('svg:line', { x1: L, x2: W - R, y1: y, y2: y, class: 'grid' }));
    svg.append(el('svg:text', { x: L - 8, y: y + 3, 'text-anchor': 'end' }, cf.format(max * (1 - i / 4))));
  }
  const slot = (W - L - R) / daily.length;
  const bw = Math.max(2, Math.min(64, slot * 0.7));
  const every = Math.ceil(daily.length / 12);
  daily.forEach((d, i) => {
    const x = L + slot * i + (slot - bw) / 2;
    let y = H - B;
    const tip = [dayLabel(d.day), ...series.map((s) => s.label + ': ' + nf.format(d[s.key]))].join('\\n');
    for (const s of series) {
      const h = ((H - T - B) * d[s.key]) / max;
      if (h <= 0) continue;
      y -= h;
      const r = el('svg:rect', { x, y, width: bw, height: h, fill: s.color });
      r.append(el('svg:title', {}, tip));
      svg.append(r);
    }
    if (i % every === 0 || i === daily.length - 1) svg.append(el('svg:text', { x: x + bw / 2, y: H - 8, 'text-anchor': 'middle' }, dayLabel(d.day)));
  });
}

function legend(node, series) {
  node.replaceChildren(...series.map((s) => { const span = el('span'); const i = el('i'); i.style.background = s.color; span.append(i, s.label); return span; }));
}

function table(node, head, rows) {
  node.replaceChildren();
  if (!rows.length) { node.append(el('caption', { class: 'empty' }, 'Nessuna richiesta nel periodo')); return; }
  const thead = el('tr');
  for (const [label, cls] of head) thead.append(el('th', cls ? { class: cls } : {}, label));
  node.appendChild(el('thead')).append(thead);
  const body = node.appendChild(el('tbody'));
  for (const cells of rows) {
    const tr = body.appendChild(el('tr'));
    cells.forEach((c, i) => tr.append(el('td', head[i][1] ? { class: head[i][1] } : {}, c)));
  }
}

// Prompt = input + cache read + cache write; the split is in the usage chart and in toonarrow stats.
const totalsCells = (t) => [nf.format(t.requests), nf.format(prompt(t)), hit(t), nf.format(t.output), nf.format(saved(t))];
const totalsHead = [['Richieste'], ['Prompt'], ['Cache hit'], ['Output'], ['Risparmiati', 'saved']];

let days = 30;
try { days = Number(localStorage.getItem('toonarrow-days')) || 30; } catch {}

async function load() {
  document.querySelectorAll('.range button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.days) === days)));
  const res = await fetch('api/summary?days=' + days);
  const s = await res.json();
  const t = s.totals;
  const sentPrompt = prompt(t);
  document.getElementById('sub').textContent = days === 1 ? 'Oggi' : 'Ultimi ' + days + ' giorni locali';
  document.getElementById('updated').textContent = 'aggiornato alle ' + new Date(s.generatedAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  document.getElementById('c-saved').textContent = cf.format(saved(t));
  document.getElementById('c-saved-note').textContent = sentPrompt ? pf.format(saved(t) / (sentPrompt + saved(t))) + ' del prompt senza toonarrow · skill ' + cf.format(t.savedSkills) + ' · shell ' + cf.format(t.savedBash) : 'nessuna riscrittura nel periodo';
  document.getElementById('c-prompt').textContent = cf.format(sentPrompt);
  document.getElementById('c-prompt-note').textContent = 'input ' + cf.format(t.input) + ' · output ' + cf.format(t.output);
  document.getElementById('c-hit').textContent = hit(t);
  document.getElementById('c-req').textContent = nf.format(t.requests);
  document.getElementById('c-req-note').textContent = s.sessions.length + ' sessioni · ' + s.clients.length + ' client · ' + nf.format(t.errors) + (t.errors === 1 ? ' errore' : ' errori');
  stacked(document.getElementById('chart-saved'), s.daily, SAVED);
  stacked(document.getElementById('chart-usage'), s.daily, USAGE);
  legend(document.getElementById('legend-saved'), SAVED);
  legend(document.getElementById('legend-usage'), USAGE);
  table(document.getElementById('t-sessions'), [['Sessione', 'left'], ['Client', 'left'], ['Modelli', 'left multi'], ['Ultima attività', 'left'], ...totalsHead],
    s.sessions.slice(0, 20).map((r) => [r.session.length > 16 ? r.session.slice(0, 14) + '…' : r.session, r.client, r.models.join(', '), when(r.last), ...totalsCells(r)]));
  table(document.getElementById('t-models'), [['Modello', 'left'], ...totalsHead], s.models.map((r) => [r.model === '?' ? '(senza modello)' : r.model, ...totalsCells(r)]));
  table(document.getElementById('t-clients'), [['Client', 'left'], ...totalsHead], s.clients.map((r) => [r.client, ...totalsCells(r)]));
}

document.querySelectorAll('.range button').forEach((b) => b.addEventListener('click', () => {
  days = Number(b.dataset.days);
  try { localStorage.setItem('toonarrow-days', String(days)); } catch {}
  load();
}));
load();
setInterval(load, 30000);
</script>
</body>
</html>
`;
