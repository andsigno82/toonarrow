/** Logo mark from assets/logo: the angle brackets and the narrowing bars, in the 800-wide logo coordinates. */
const MARK_BRACKETS = 'M142 96 L61 174 L61 191 L142 269 L150 269 L150 241 L91 182.5 L150 124 L150 96 Z M658 96 L739 174 L739 191 L658 269 L650 269 L650 241 L709 182.5 L650 124 L650 96 Z';
const MARK_BARS = 'M176 108 H272 L287 123 V133 H176 Z M176 149 H337 L352 164 V174 H176 Z M176 189 H352 V199 L337 214 H176 Z M176 230 H273 V255 H176 Z M360 171 H466 V196 H360 Z';
const markPaths = (brackets: string, bars: string) =>
  `<path d="${MARK_BRACKETS}" fill="${brackets}"/><path transform="translate(-88 0) scale(1.5 1)" d="${MARK_BARS}" fill="${bars}"/>`;
/** Same as assets/logo/icon-dark.svg, inlined so the page stays self-contained. */
const FAVICON = 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -217 800 800"><rect x="0" y="-217" width="800" height="800" fill="#151410"/>${markPaths('#ebe7dc', '#6cc28a')}</svg>`,
);

/** Local dashboard served by the proxy at /_toonarrow/. Self-contained: inline CSS, SVG charts, data from api/summary. */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>toonarrow dashboard</title>
<link rel="icon" type="image/svg+xml" href="${FAVICON}">
<style>
:root {
  --bg: #f6f4ee; --surface: #fffdf8; --ink: #1f1d18; --muted: #6d685d; --line: #e3ded2; --accent: #2d7a4b;
  --saved-skills: #2d7a4b; --saved-bash: #93c9a5; --saved-tools: #c9a227;
  --u-input: #c5582f; --u-read: #2d7a4b; --u-write: #d8a23f; --u-output: #4b6fa6;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #151410; --surface: #1d1c17; --ink: #ebe7dc; --muted: #a29d90; --line: #34322a; --accent: #6cc28a;
    --saved-skills: #5bb57d; --saved-bash: #2f6b45; --saved-tools: #b8962e;
    --u-input: #e07a52; --u-read: #5bb57d; --u-write: #e0b45a; --u-output: #7d9bd0;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
.mono, .label, th { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
.wrap { max-width: 1080px; margin: 0 auto; padding: 24px 16px 48px; }
header { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 24px; justify-content: space-between; padding-bottom: 16px; border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: 10px; font-family: ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: .12em; text-transform: uppercase; font-size: 13px; }
.brand svg { width: 52px; flex: none; }
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
    <div class="brand"><svg viewBox="56 90 688 185" aria-hidden="true">${markPaths('var(--ink)', 'var(--accent)')}</svg><span><b>toonarrow</b> &nbsp;context compression proxy</span></div>
    <div class="range" role="group" data-i18n-label="period">
      <button data-days="1" data-i18n="today"></button><button data-days="7" data-i18n="d7"></button><button data-days="30" data-i18n="d30"></button><button data-days="90" data-i18n="d90"></button>
    </div>
    <div class="range" role="group" data-i18n-label="language">
      <button data-lang="it" lang="it">IT</button><button data-lang="en" lang="en">EN</button>
    </div>
    <div class="updated" id="updated"></div>
  </header>

  <h1>Dashboard</h1>
  <p class="sub" id="sub"></p>

  <div class="cards">
    <div class="card hero"><div class="label" data-i18n="saved"></div><div class="value" id="c-saved">-</div><div class="note" id="c-saved-note"></div></div>
    <div class="card"><div class="label" data-i18n="promptSent"></div><div class="value" id="c-prompt">-</div><div class="note" id="c-prompt-note"></div></div>
    <div class="card"><div class="label">Cache hit</div><div class="value" id="c-hit">-</div><div class="note" data-i18n="hitNote"></div></div>
    <div class="card"><div class="label" data-i18n="requests"></div><div class="value" id="c-req">-</div><div class="note" id="c-req-note"></div></div>
  </div>

  <div class="panel">
    <h2 data-i18n="savedPerDay"></h2>
    <svg id="chart-saved" viewBox="0 0 1000 240" role="img" data-i18n-label="savedPerDay"></svg>
    <div class="legend" id="legend-saved"></div>
  </div>

  <div class="panel">
    <h2 data-i18n="usedPerDay"></h2>
    <svg id="chart-usage" viewBox="0 0 1000 240" role="img" data-i18n-label="usedPerDay"></svg>
    <div class="legend" id="legend-usage"></div>
  </div>

  <div class="panel">
    <h2 data-i18n="recentSessions"></h2>
    <div class="table-wrap"><table id="t-sessions"></table></div>
  </div>

  <div class="panel"><h2 data-i18n="byModel"></h2><div class="table-wrap"><table id="t-models"></table></div></div>
  <div class="panel"><h2 data-i18n="byClient"></h2><div class="table-wrap"><table id="t-clients"></table></div></div>

  <div class="panel method">
    <h2 data-i18n="howTitle"></h2>
    <div data-i18n-html="how"></div>
  </div>
</div>

<script>
const I18N = {
  it: {
    period: 'Periodo', language: 'Lingua', today: 'oggi', d7: '7 giorni', d30: '30 giorni', d90: '90 giorni',
    saved: 'Token risparmiati (stima)', promptSent: 'Token di prompt inviati', hitNote: 'cache read / token di prompt', requests: 'Richieste',
    savedPerDay: 'Token risparmiati per giorno', usedPerDay: 'Token consumati per giorno', recentSessions: 'Sessioni recenti', byModel: 'Per modello', byClient: 'Per client',
    howTitle: 'Come sono calcolati',
    how: 'I token consumati sono quelli dichiarati dal provider in ogni risposta, come in <code>toonarrow stats</code>: <code>input</code> esclude i token letti dalla cache. '
      + 'I token risparmiati sono una stima: per ogni richiesta riscritta, i caratteri tolti da toonarrow (descrizioni delle skill, output dei comandi shell) '
      + 'sono convertiti con la densità della richiesta stessa, cioè token di prompt fatturati diviso byte effettivamente inviati. '
      + 'Sono token che altrimenti sarebbero stati inviati in quella richiesta, in cache o no.',
    skills: 'Elenco skill', shell: 'Output shell', search: 'Risultati di ricerca',
    session: 'Sessione', client: 'Client', models: 'Modelli', lastActivity: 'Ultima attività', model: 'Modello', saveCol: 'Risparmiati', noModel: '(senza modello)', empty: 'Nessuna richiesta nel periodo',
    updated: (t) => 'aggiornato alle ' + t, todaySub: 'Oggi', lastDays: (n) => 'Ultimi ' + n + ' giorni locali',
    savedNote: (pct, sk, sh, se) => pct + ' del prompt senza toonarrow · skill ' + sk + ' · shell ' + sh + ' · ricerca ' + se, noRewrites: 'nessuna riscrittura nel periodo',
    inOut: (i, o) => 'input ' + i + ' · output ' + o,
    reqNote: (s, c, e, eN, other) => s + ' sessioni · ' + c + ' client · ' + e + (eN === 1 ? ' errore' : ' errori') + (other ? ' · ' + other + ' non di inferenza escluse' : ''),
  },
  en: {
    period: 'Period', language: 'Language', today: 'today', d7: '7 days', d30: '30 days', d90: '90 days',
    saved: 'Tokens saved (estimate)', promptSent: 'Prompt tokens sent', hitNote: 'cache read / prompt tokens', requests: 'Requests',
    savedPerDay: 'Tokens saved per day', usedPerDay: 'Tokens used per day', recentSessions: 'Recent sessions', byModel: 'By model', byClient: 'By client',
    howTitle: 'How these are computed',
    how: 'Tokens used are the ones the provider reports in each response, as in <code>toonarrow stats</code>: <code>input</code> excludes tokens read from the cache. '
      + 'Tokens saved are an estimate: for each rewritten request, the characters toonarrow removed (skill descriptions, shell command output) '
      + 'are converted with that request\\'s own density, that is billed prompt tokens divided by bytes actually sent. '
      + 'They are tokens that would otherwise have been sent in that request, cached or not.',
    skills: 'Skill listing', shell: 'Shell output', search: 'Search results',
    session: 'Session', client: 'Client', models: 'Models', lastActivity: 'Last activity', model: 'Model', saveCol: 'Saved', noModel: '(no model)', empty: 'No requests in this period',
    updated: (t) => 'updated at ' + t, todaySub: 'Today', lastDays: (n) => 'Last ' + n + ' local days',
    savedNote: (pct, sk, sh, se) => pct + ' of the prompt without toonarrow · skills ' + sk + ' · shell ' + sh + ' · search ' + se, noRewrites: 'no rewrites in this period',
    inOut: (i, o) => 'input ' + i + ' · output ' + o,
    reqNote: (s, c, e, eN, other) => s + (s === '1' ? ' session · ' : ' sessions · ') + c + (c === '1' ? ' client · ' : ' clients · ') + e + (eN === 1 ? ' error' : ' errors') + (other ? ' · ' + other + ' non-inference excluded' : ''),
  },
};
const SAVED = [
  { key: 'savedSkills', label: 'skills', color: 'var(--saved-skills)' },
  { key: 'savedBash', label: 'shell', color: 'var(--saved-bash)' },
  { key: 'savedTools', label: 'search', color: 'var(--saved-tools)' },
];
const USAGE = [
  { key: 'cacheRead', name: 'Cache read', color: 'var(--u-read)' },
  { key: 'cacheWrite', name: 'Cache write', color: 'var(--u-write)' },
  { key: 'input', name: 'Input', color: 'var(--u-input)' },
  { key: 'output', name: 'Output', color: 'var(--u-output)' },
];
const SVG = 'http://www.w3.org/2000/svg';

function stored(key) { try { return localStorage.getItem(key); } catch { return null; } }
function store(key, value) { try { localStorage.setItem(key, value); } catch {} }

let lang = stored('toonarrow-lang');
if (!I18N[lang]) lang = (navigator.languages || [navigator.language]).some((l) => String(l).toLowerCase().startsWith('it')) ? 'it' : 'en';
let msg, locale, nf, cf, pf;
function setLang(next) {
  lang = next;
  msg = I18N[lang];
  locale = lang === 'it' ? 'it-IT' : 'en-US';
  nf = new Intl.NumberFormat(locale);
  cf = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });
  pf = new Intl.NumberFormat(locale, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = msg[n.dataset.i18n]; });
  document.querySelectorAll('[data-i18n-html]').forEach((n) => { n.innerHTML = msg[n.dataset.i18nHtml]; });
  document.querySelectorAll('[data-i18n-label]').forEach((n) => n.setAttribute('aria-label', msg[n.dataset.i18nLabel]));
  document.querySelectorAll('[data-lang]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
}
const seriesLabel = (s) => s.name || msg[s.label];

const saved = (t) => t.savedSkills + t.savedBash + (t.savedTools ?? 0);
const prompt = (t) => t.input + t.cacheRead + t.cacheWrite;
const hit = (t) => (prompt(t) ? pf.format(t.cacheRead / prompt(t)) : '-');
const dayLabel = (d) => new Date(d + 'T12:00:00').toLocaleDateString(locale, { day: 'numeric', month: 'short' });
const when = (ts) => new Date(ts).toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

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
    const tip = [dayLabel(d.day), ...series.map((s) => seriesLabel(s) + ': ' + nf.format(d[s.key]))].join('\\n');
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
  node.replaceChildren(...series.map((s) => { const span = el('span'); const i = el('i'); i.style.background = s.color; span.append(i, seriesLabel(s)); return span; }));
}

function table(node, head, rows) {
  node.replaceChildren();
  if (!rows.length) { node.append(el('caption', { class: 'empty' }, msg.empty)); return; }
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
const totalsHead = () => [[msg.requests], ['Prompt'], ['Cache hit'], ['Output'], [msg.saveCol, 'saved']];

let days = Number(stored('toonarrow-days')) || 30;
let last;

function render(s) {
  document.querySelectorAll('[data-days]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.days) === days)));
  if (!s) return;
  const t = s.totals;
  const sentPrompt = prompt(t);
  document.getElementById('sub').textContent = days === 1 ? msg.todaySub : msg.lastDays(days);
  document.getElementById('updated').textContent = msg.updated(new Date(s.generatedAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }));
  document.getElementById('c-saved').textContent = cf.format(saved(t));
  document.getElementById('c-saved-note').textContent = sentPrompt ? msg.savedNote(pf.format(saved(t) / (sentPrompt + saved(t))), cf.format(t.savedSkills), cf.format(t.savedBash), cf.format(t.savedTools ?? 0)) : msg.noRewrites;
  document.getElementById('c-prompt').textContent = cf.format(sentPrompt);
  document.getElementById('c-prompt-note').textContent = msg.inOut(cf.format(t.input), cf.format(t.output));
  document.getElementById('c-hit').textContent = hit(t);
  document.getElementById('c-req').textContent = nf.format(t.requests);
  document.getElementById('c-req-note').textContent = msg.reqNote(nf.format(s.sessions.length), nf.format(s.clients.length), nf.format(t.errors), t.errors, s.otherRequests ? nf.format(s.otherRequests) : '');
  stacked(document.getElementById('chart-saved'), s.daily, SAVED);
  stacked(document.getElementById('chart-usage'), s.daily, USAGE);
  legend(document.getElementById('legend-saved'), SAVED);
  legend(document.getElementById('legend-usage'), USAGE);
  table(document.getElementById('t-sessions'), [[msg.session, 'left'], [msg.client, 'left'], [msg.models, 'left multi'], [msg.lastActivity, 'left'], ...totalsHead()],
    s.sessions.slice(0, 20).map((r) => [r.session.length > 16 ? r.session.slice(0, 14) + '…' : r.session, r.client, r.models.join(', '), when(r.last), ...totalsCells(r)]));
  table(document.getElementById('t-models'), [[msg.model, 'left'], ...totalsHead()], s.models.map((r) => [r.model === '?' ? msg.noModel : r.model, ...totalsCells(r)]));
  table(document.getElementById('t-clients'), [[msg.client, 'left'], ...totalsHead()], s.clients.map((r) => [r.client, ...totalsCells(r)]));
}

async function load() {
  render(last);
  const res = await fetch('api/summary?days=' + days);
  last = await res.json();
  render(last);
}

document.querySelectorAll('[data-days]').forEach((b) => b.addEventListener('click', () => {
  days = Number(b.dataset.days);
  store('toonarrow-days', String(days));
  load();
}));
document.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => {
  store('toonarrow-lang', b.dataset.lang);
  setLang(b.dataset.lang);
  render(last);
}));
setLang(lang);
load();
setInterval(load, 30000);
</script>
</body>
</html>
`;
