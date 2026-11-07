/**
 * Dashboard pages as pure functions: data in, an HTML string out. No I/O and
 * no clock reads (callers pass `now`), so every page is a unit test away.
 *
 * Every interpolated value goes through `esc`. Trace text is agent output and
 * compat details are CLI output; both are untrusted, and the page is served
 * from loopback, where an injected script could read every other run.
 */
import { FAILURE_KINDS } from '../failures.js';

export const OUTCOMES = Object.freeze(['stuck', 'failed', 'running', 'cancelled', 'ok']);

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

const isNum = (value) => typeof value === 'number' && Number.isFinite(value);
const clip = (text, max) => {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

export const fmtDuration = (ms) => {
  if (!isNum(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
};

const toMs = (iso) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

export const fmtAgo = (iso, now) => {
  const t = toMs(iso);
  if (t === null) return '—';
  const s = Math.round((now - t) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return String(iso).slice(0, 10);
};

// A failure kind outside FAILURE_KINDS still renders; it just has no meaning to show.
const meaningOf = (kind) => (kind && Object.hasOwn(FAILURE_KINDS, kind) ? FAILURE_KINDS[kind].meaning : '');

const badge = (outcome) => {
  const known = OUTCOMES.includes(outcome) ? outcome : 'unknown';
  return `<span class="badge b-${known}">${esc(outcome || 'unknown')}</span>`;
};

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--surface:#fff;--tint:#f2f4f7;--fg:#101828;--fg2:#475467;--fg3:#667085;
--border:#d0d5dd;--border-soft:#e4e7ec;--accent:#1d3fd1;--accent-soft:#e9edfb;
--ok:#0f7a53;--ok-soft:#e3f6ec;--bad:#b42318;--bad-soft:#fdecea;--warn:#8a4b00;--warn-soft:#fdefdc;--warn-line:#f4a23a;}
@media (prefers-color-scheme:dark){:root{--bg:#0e1116;--surface:#151a21;--tint:#1b212a;--fg:#e6e8eb;--fg2:#b0b7c3;--fg3:#8a93a1;
--border:#2c3440;--border-soft:#232a34;--accent:#8ea2ff;--accent-soft:#1c2550;
--ok:#5dd3a2;--ok-soft:#10291f;--bad:#ff8f86;--bad-soft:#2f1414;--warn:#ffc46b;--warn-soft:#30220c;--warn-line:#f4a23a;}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.mono,code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px}
header{border-bottom:1px solid var(--border);background:var(--surface)}
.bar{max-width:1120px;margin:0 auto;padding:10px 16px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.brand{font-weight:600;color:var(--fg)}
nav{display:flex;gap:4px;flex-wrap:wrap;min-width:0}
nav a{color:var(--fg2);padding:4px 10px;border-radius:4px;border:1px solid transparent;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
nav a[aria-current=page]{color:var(--accent);background:var(--accent-soft);border-color:var(--accent-soft)}
main{max-width:1120px;margin:0 auto;padding:16px}
h1{font-size:18px;margin:4px 0 12px;font-weight:600;overflow-wrap:anywhere}
h2{font-size:14px;margin:20px 0 8px;font-weight:600;color:var(--fg2)}
.muted{color:var(--fg3)}.small{font-size:12px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:6px}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;background:var(--surface);border:1px solid var(--border);border-radius:6px}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border-soft);vertical-align:top}
th{font-weight:600;color:var(--fg2);font-size:12px;background:var(--tint);white-space:nowrap}
tr:last-child td{border-bottom:0}
.nowrap{white-space:nowrap}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid var(--border);color:var(--fg2);white-space:nowrap}
.b-ok{color:var(--ok);background:var(--ok-soft);border-color:transparent}
.b-failed{color:var(--bad);background:var(--bad-soft);border-color:transparent}
.b-stuck{color:var(--warn);background:var(--warn-soft);border-color:var(--warn-line)}
.b-running{color:var(--accent);background:var(--accent-soft);border-color:transparent}
.b-running::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor;margin-right:5px;vertical-align:1px}
tr.stuck td{background:var(--warn-soft)}tr.stuck td:first-child{box-shadow:inset 3px 0 0 var(--warn-line)}
.alert{border:1px solid var(--warn-line);background:var(--warn-soft);color:var(--warn);border-radius:6px;padding:10px 12px;margin:0 0 12px;font-weight:600}
.alert a{color:inherit;text-decoration:underline}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 12px}
.chips a{border:1px solid var(--border);border-radius:999px;padding:2px 10px;color:var(--fg2);background:var(--surface);font-size:13px}
.chips a[aria-current=true]{border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}
.empty{padding:24px 16px;text-align:center;color:var(--fg3)}
.meta{display:flex;gap:8px 20px;flex-wrap:wrap;margin:0 0 12px;color:var(--fg2)}
.meta b{color:var(--fg);font-weight:600}
.reply{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:12px;font-family:inherit;font-size:14px}
.settle{padding:10px 12px;margin:0 0 12px}
.settle.failed{border-color:var(--bad)}.settle.stuck{border-color:var(--warn-line);background:var(--warn-soft)}
td.sum{overflow-wrap:anywhere;min-width:220px}
tr.live td{background:var(--warn-soft)}tr.live td:first-child{box-shadow:inset 3px 0 0 var(--warn-line)}
tr.audit td:first-child{box-shadow:inset 3px 0 0 var(--accent)}
tr.denied td{background:var(--bad-soft)}
tr.settled td{background:var(--tint);font-weight:500}
.tag{display:inline-block;font-size:11px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:var(--fg3);margin-right:6px}
.c-pass{color:var(--ok)}.c-fail{color:var(--bad)}.c-skip{color:var(--fg3)}
td.cell{min-width:120px}td.cell .detail{display:block;color:var(--fg3);font-size:12px;overflow-wrap:anywhere;max-width:260px}
td.cell.fail{background:var(--bad-soft)}
th.check{white-space:normal;min-width:110px;max-width:180px}
th.rowh{position:sticky;left:0;background:var(--surface);z-index:1;font-size:13px;color:var(--fg)}
thead th.rowh{background:var(--tint);color:var(--fg2);font-size:12px}
td.fail-cell{min-width:220px}
@media (max-width:600px){main{padding:12px 16px}th,td{padding:7px 8px}
.timeline thead{display:none}
.timeline tr{display:grid;grid-template-columns:auto auto 1fr;column-gap:10px;border-bottom:1px solid var(--border-soft)}
.timeline tr:last-child{border-bottom:0}
.timeline td{border-bottom:0;padding:6px 10px 0}
.timeline td.sum{grid-column:1/-1;min-width:0;padding:2px 10px 8px}
.timeline tr.live,.timeline tr.denied,.timeline tr.settled{background:var(--warn-soft)}
.timeline tr.denied{background:var(--bad-soft)}.timeline tr.settled{background:var(--tint)}
.timeline tr.live{box-shadow:inset 3px 0 0 var(--warn-line)}.timeline tr.audit{box-shadow:inset 3px 0 0 var(--accent)}
.timeline tr td:first-child{box-shadow:none}}
`;

/** Shared page shell. `active` is 'runs' | 'run' | 'compat'; `runId` labels the detail tab. */
export const layout = ({ title, active, body, runId = null, head = '' }) => {
  const link = (key, href, label) => `<a href="${esc(href)}"${active === key ? ' aria-current="page"' : ''}>${esc(label)}</a>`;
  const runTab = runId ? link('run', `/runs/${encodeURIComponent(runId)}`, `Run ${runId}`) : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style>${head}</head>
<body><header><div class="bar"><span class="brand">Seats</span><nav>${link('runs', '/', 'Runs')}${runTab}${link('compat', '/compat', 'Compatibility')}</nav></div></header>
<main>${body}</main></body></html>`;
};

const runHref = (runId) => `/runs/${encodeURIComponent(runId)}`;
const shortId = (id) => (String(id).length > 14 ? `${String(id).slice(0, 8)}…` : String(id));

// Reload only while the tab is visible, so a background tab does not poll the disk.
const REFRESH_SCRIPT = '<script>setInterval(function(){if(!document.hidden)location.reload()},5000)</script>';

/**
 * Runs list. `runs` is `store.listRuns()` output; `outcome` filters it.
 * Stuck runs get an alert line, a tinted row and the first filter chip:
 * a stuck run is the one a person has to act on.
 */
export const renderRuns = (runs = [], { outcome = null, now = Date.now(), refresh = true } = {}) => {
  const all = Array.isArray(runs) ? runs.filter((r) => r && typeof r === 'object') : [];
  const filter = OUTCOMES.includes(outcome) ? outcome : null;
  const counts = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
  for (const r of all) if (Object.hasOwn(counts, r.outcome)) counts[r.outcome] += 1;
  const shown = filter ? all.filter((r) => r.outcome === filter) : all;

  const q = (o) => {
    const params = new URLSearchParams();
    if (o) params.set('outcome', o);
    if (!refresh) params.set('refresh', '0');
    const s = params.toString();
    return s ? `/?${s}` : '/';
  };
  const chip = (o, label, n) => `<a href="${esc(q(o))}"${filter === o ? ' aria-current="true"' : ''}>${esc(label)} <span class="muted">${n}</span></a>`;
  const chips = `<div class="chips">${chip(null, 'All', all.length)}${OUTCOMES.map((o) => chip(o, o, counts[o])).join('')}</div>`;

  const alert = counts.stuck
    ? `<p class="alert" role="status">${counts.stuck} stuck ${counts.stuck === 1 ? 'run' : 'runs'}: ${esc(FAILURE_KINDS.stuck.meaning)}. <a href="${esc(q('stuck'))}">Show stuck</a></p>`
    : '';

  const row = (r) => {
    const id = String(r.runId ?? '');
    const started = toMs(r.startedAt);
    const duration = r.outcome === 'running' && started !== null
      ? `<span class="muted">${esc(fmtDuration(now - started))} so far</span>`
      : esc(fmtDuration(r.durationMs));
    const kind = r.failure?.kind;
    const failure = kind
      ? `<span class="mono">${esc(kind)}</span>${meaningOf(kind) ? `<div class="muted small">${esc(meaningOf(kind))}</div>` : ''}`
      : '<span class="muted">—</span>';
    return `<tr class="${r.outcome === 'stuck' ? 'stuck' : ''}">
<td class="nowrap"><a class="mono" href="${esc(runHref(id))}" title="${esc(id)}">${esc(shortId(id))}</a>${r.label ? `<div class="muted small">${esc(clip(r.label, 60))}</div>` : ''}</td>
<td>${badge(r.outcome)}</td>
<td class="nowrap">${esc(r.adapter || '—')}</td>
<td class="nowrap" title="${esc(r.startedAt || '')}">${esc(fmtAgo(r.startedAt, now))}</td>
<td class="nowrap">${duration}</td>
<td class="fail-cell">${failure}</td></tr>`;
  };

  const table = shown.length
    ? `<div class="scroll"><table><thead><tr><th>Run</th><th>Outcome</th><th>Adapter</th><th>Started</th><th>Duration</th><th>Failure</th></tr></thead>
<tbody>${shown.map(row).join('')}</tbody></table></div>`
    : `<div class="card empty">${all.length ? `No ${esc(filter)} runs.` : 'No runs recorded yet.'}</div>`;

  const refreshNote = refresh
    ? `<p class="muted small">Refreshes every 5s. <a href="${esc(filter ? `/?outcome=${filter}&refresh=0` : '/?refresh=0')}">Pause</a></p>`
    : `<p class="muted small">Auto-refresh paused. <a href="${esc(filter ? `/?outcome=${filter}` : '/')}">Resume</a></p>`;

  return layout({
    title: filter ? `Runs: ${filter}` : 'Runs',
    active: 'runs',
    head: refresh ? REFRESH_SCRIPT : '',
    body: `<h1>Runs</h1>${alert}${chips}${table}${refreshNote}`,
  });
};

// Names-only rendering: the audit rows read named fields and never dump `data`,
// so a value smuggled into a credential event still does not reach the page.
const names = (list) => (Array.isArray(list) && list.length
  ? list.map((n) => `<code>${esc(n)}</code>`).join(', ')
  : '<span class="muted">none</span>');

const kv = (pairs) => pairs.filter(([, v]) => v !== undefined && v !== null && v !== '')
  .map(([k, v]) => `<span class="muted">${esc(k)}</span> ${esc(v)}`).join(' · ');

const summarize = (event, tools) => {
  const d = event.data && typeof event.data === 'object' ? event.data : {};
  switch (event.type) {
    case 'run.started': {
      const cli = d.cli && d.cli.name ? `${d.cli.name}${d.cli.version ? `@${d.cli.version}` : ''}` : null;
      return kv([['adapter', d.adapter], ['cli', cli], ['session', d.sessionId], ['attempt', d.attempt]]);
    }
    case 'run.settled': {
      const kind = d.failure?.kind;
      const head = `${badge(d.outcome)} ${kv([['duration', isNum(d.durationMs) ? fmtDuration(d.durationMs) : null], ['attempts', d.attempts]])}`;
      if (!kind) return head;
      return `${head}<div><span class="mono">${esc(kind)}</span>${meaningOf(kind) ? ` <span class="muted">— ${esc(meaningOf(kind))}</span>` : ''}</div>${d.failure.detail ? `<div class="muted small">${esc(clip(d.failure.detail, 400))}</div>` : ''}`;
    }
    case 'turn.prompt_sent': return kv([['chars', d.chars]]);
    case 'agent.message_chunk': return esc(clip(d.text, 160));
    case 'agent.thought_chunk': return kv([['chars', d.chars]]);
    case 'tool.call': return `<b>${esc(clip(d.title || '(untitled)', 200))}</b> ${kv([['kind', d.kind], ['status', d.status], ['id', d.toolCallId]])}`;
    case 'tool.update': return kv([['id', d.toolCallId], ['status', d.status], ['title', d.title ? clip(d.title, 200) : null]]);
    case 'plan': {
      const entries = Array.isArray(d.entries) ? d.entries : [];
      return entries.length
        ? entries.slice(0, 8).map((e) => `<div><span class="muted">[${esc(e?.status || '?')}]</span> ${esc(clip(e?.content, 160))}</div>`).join('') + (entries.length > 8 ? `<div class="muted">+${entries.length - 8} more</div>` : '')
        : '<span class="muted">empty plan</span>';
    }
    case 'permission.requested': {
      const title = d.toolCallId && tools.get(d.toolCallId);
      const opts = Array.isArray(d.options) ? d.options.map((o) => `${o?.optionId ?? '?'}${o?.kind ? ` (${o.kind})` : ''}`).join(', ') : '';
      return `<span class="tag">permission</span>${title ? `<b>${esc(clip(title, 200))}</b> ` : ''}${kv([['ask', d.question ? clip(d.question, 200) : null], ['asked of', d.askedOf?.role], ['tool', d.toolCallId], ['options', opts]])}`;
    }
    case 'permission.decided':
      return `<span class="tag">permission</span>${kv([['outcome', d.outcome], ['option', d.optionId], ['kind', d.kind], ['by', d.decidedByRole]])}`;
    case 'usage': {
      const n = (v) => (isNum(v) ? String(v) : 'unknown');
      return kv([['in', n(d.inputTokens)], ['out', n(d.outputTokens)], ['total', n(d.totalTokens)], ['cost', isNum(d.cost) ? d.cost : 'unknown']]);
    }
    case 'liveness.stalled':
      return `<b>Stalled</b> — idle ${esc(fmtDuration(d.idleMs))} of a ${esc(fmtDuration(d.windowMs))} window`;
    case 'liveness.recovery':
      return `<b>Recovery</b> — ${kv([['action', d.action], ['attempt', d.attempt]])}`;
    case 'credential.granted': return `<span class="tag">credential</span>granted ${names(d.names)}`;
    case 'credential.denied': return `<span class="tag">credential</span>denied ${names(d.name ? [d.name] : [])}`;
    case 'process.exited': return kv([['code', d.code], ['signal', d.signal]]);
    default: {
      let json = '';
      try { json = JSON.stringify(d); } catch { json = '(unreadable)'; }
      return `<span class="mono">${esc(clip(json, 200))}</span>`;
    }
  }
};

const ROW_CLASS = {
  'liveness.stalled': 'live',
  'liveness.recovery': 'live',
  'permission.requested': 'audit',
  'permission.decided': 'audit',
  'credential.granted': 'audit',
  'credential.denied': 'audit denied',
  'run.settled': 'settled',
};

const fmtOffset = (ms) => (ms === null ? '—' : `+${ms < 60000 ? `${(ms / 1000).toFixed(3)}s` : fmtDuration(ms)}`);

/**
 * Run detail: a header, the settle verdict, the reply text, then the timeline.
 * Consecutive message/thought chunks fold into one timeline row — the reply
 * block above already carries the text, and a chunk per row buries the
 * liveness and audit rows that matter.
 */
export const renderRun = (events = [], { runId = null } = {}) => {
  const list = Array.isArray(events) ? events.filter((e) => e && typeof e === 'object') : [];
  const id = runId ?? list[0]?.runId ?? '';
  const started = list.find((e) => e.type === 'run.started')?.data || {};
  const settled = list.find((e) => e.type === 'run.settled')?.data || null;
  const outcome = settled?.outcome || 'running';
  const reply = list.filter((e) => e.type === 'agent.message_chunk').map((e) => String(e.data?.text ?? '')).join('');
  const tools = new Map(list.filter((e) => e.type === 'tool.call' && e.data?.toolCallId).map((e) => [e.data.toolCallId, e.data.title]));
  const t0 = toMs(list[0]?.ts);
  const stalls = list.filter((e) => e.type === 'liveness.stalled').length;
  const recoveries = list.filter((e) => e.type === 'liveness.recovery').length;

  const groups = [];
  for (const e of list) {
    const last = groups[groups.length - 1];
    const foldable = e.type === 'agent.message_chunk' || e.type === 'agent.thought_chunk';
    if (foldable && last && last.type === e.type) last.events.push(e);
    else groups.push({ type: e.type, events: [e] });
  }

  const row = (g) => {
    const first = g.events[0];
    const lastE = g.events[g.events.length - 1];
    const offset = t0 === null ? null : (toMs(first.ts) ?? t0) - t0;
    const seq = g.events.length > 1 ? `${first.seq}–${lastE.seq}` : first.seq;
    let sum;
    if (g.events.length > 1 && g.type === 'agent.message_chunk') {
      const text = g.events.map((e) => String(e.data?.text ?? '')).join('');
      sum = `<span class="muted">${g.events.length} chunks, ${text.length} chars:</span> ${esc(clip(text, 160))}`;
    } else if (g.events.length > 1) {
      const chars = g.events.reduce((n, e) => n + (isNum(e.data?.chars) ? e.data.chars : 0), 0);
      sum = `<span class="muted">${g.events.length} chunks, ${chars} chars</span>`;
    } else {
      sum = summarize(first, tools);
    }
    return `<tr class="${ROW_CLASS[g.type] || ''}"><td class="nowrap mono">${esc(seq)}</td><td class="nowrap mono" title="${esc(first.ts || '')}">${esc(fmtOffset(offset))}</td><td class="nowrap mono">${esc(first.type)}</td><td class="sum">${sum}</td></tr>`;
  };

  const cli = started.cli?.name ? `${started.cli.name}${started.cli.version ? `@${started.cli.version}` : ''}` : null;
  const metaPairs = [['Outcome', null, badge(outcome)], ['Adapter', started.adapter], ['CLI', cli], ['Duration', settled && isNum(settled.durationMs) ? fmtDuration(settled.durationMs) : null], ['Attempts', settled?.attempts], ['Events', list.length]];
  if (stalls) metaPairs.push(['Stalls', stalls]);
  if (recoveries) metaPairs.push(['Recoveries', recoveries]);
  const meta = `<div class="meta">${metaPairs.filter(([, v, html]) => html || (v !== undefined && v !== null)).map(([k, v, html]) => `<span>${esc(k)} ${html || `<b>${esc(v)}</b>`}</span>`).join('')}</div>`;

  const kind = settled?.failure?.kind;
  const verdict = kind
    ? `<div class="card settle ${esc(OUTCOMES.includes(outcome) ? outcome : '')}"><b class="mono">${esc(kind)}</b>${meaningOf(kind) ? ` — ${esc(meaningOf(kind))}` : ''}${settled.failure.detail ? `<div class="muted small">${esc(clip(settled.failure.detail, 600))}</div>` : ''}</div>`
    : '';

  const replyBlock = `<h2>Reply</h2>${reply ? `<div class="card"><pre class="reply">${esc(reply)}</pre></div>` : '<div class="card empty">No agent text.</div>'}`;
  const timeline = `<h2>Timeline</h2>${list.length
    ? `<div class="scroll"><table class="timeline"><thead><tr><th>Seq</th><th>Time</th><th>Type</th><th>Detail</th></tr></thead><tbody>${groups.map(row).join('')}</tbody></table></div>`
    : '<div class="card empty">No events yet.</div>'}`;

  return layout({
    title: `Run ${id}`,
    active: 'run',
    runId: id || null,
    body: `<h1 class="mono">${esc(id)}</h1>${meta}${verdict}${replyBlock}${timeline}`,
  });
};

const STATUS = new Set(['pass', 'fail', 'skip']);

/**
 * Compatibility grid: one row per CLI@version, one column per check id, in
 * first-seen order. Missing results, rows or checks render as empty states;
 * a results.json written by an older or newer tool still shows what it can.
 */
export const renderCompat = (results, { error = null } = {}) => {
  const rows = Array.isArray(results?.rows) ? results.rows.filter((r) => r && typeof r === 'object') : [];
  const columns = new Map();
  for (const r of rows) {
    for (const c of Array.isArray(r.checks) ? r.checks : []) {
      if (c && c.id !== undefined && !columns.has(String(c.id))) columns.set(String(c.id), c.title || String(c.id));
    }
  }

  const host = results?.host || {};
  const metaPairs = [['Generated', results?.generatedAt], ['OS', host.os], ['Arch', host.arch], ['Node', host.node], ['Schema', results?.schemaVersion]];
  const meta = `<div class="meta">${metaPairs.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `<span>${esc(k)} <b>${esc(v)}</b></span>`).join('')}</div>`;

  const cell = (check) => {
    if (!check) return '<td class="cell"><span class="muted">—</span></td>';
    const status = STATUS.has(check.status) ? check.status : 'unknown';
    const ms = isNum(check.ms) ? ` <span class="muted small">${esc(fmtDuration(check.ms))}</span>` : '';
    const detail = check.detail && status !== 'pass' ? `<span class="detail">${esc(clip(check.detail, 240))}</span>` : '';
    return `<td class="cell ${status}" title="${esc(clip(check.detail || '', 1000))}"><b class="c-${status}">${esc(check.status || 'unknown')}</b>${ms}${detail}</td>`;
  };

  const row = (r) => {
    const checks = new Map((Array.isArray(r.checks) ? r.checks : []).filter((c) => c && c.id !== undefined).map((c) => [String(c.id), c]));
    const pass = [...checks.values()].filter((c) => c.status === 'pass').length;
    const label = `${r.cli || '(unknown cli)'}${r.version ? `@${r.version}` : ''}`;
    return `<tr><th class="rowh mono" scope="row">${esc(label)}<div class="muted small">${pass}/${checks.size} pass</div></th>${[...columns.keys()].map((k) => cell(checks.get(k))).join('')}</tr>`;
  };

  let body;
  if (error) body = `<div class="card empty">${esc(error)}</div>`;
  else if (!rows.length) body = '<div class="card empty">No compatibility results. Start the dashboard with <code>--compat &lt;results.json&gt;</code>.</div>';
  else {
    body = `${meta}<div class="scroll"><table><thead><tr><th class="rowh">CLI</th>${[...columns].map(([k, title]) => `<th class="check" title="${esc(k)}">${esc(title)}</th>`).join('')}</tr></thead>
<tbody>${rows.map(row).join('')}</tbody></table></div>`;
  }
  return layout({ title: 'Compatibility', active: 'compat', body: `<h1>Compatibility</h1>${body}` });
};

/** 404/500 page in the same shell. */
export const renderError = (status, message) => layout({
  title: String(status),
  active: null,
  body: `<h1>${esc(status)}</h1><div class="card empty">${esc(message)}</div>`,
});
