/**
 * Render a results document as one self-contained HTML page: no external
 * scripts, styles, fonts or images, so the artifact opens anywhere and a
 * Pages deploy needs nothing but this file. Every value from the results is
 * escaped — detail strings carry CLI and provider output.
 */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

const MARK = { pass: '✓', fail: '✗', skip: '–', limit: '!' };
const STATUSES = new Set(['pass', 'fail', 'skip']);

/** A failing row is a limit when its target declares one for that check (run.js limitOf). */
export const isLimitRow = (row) => row?.status === 'fail' && typeof row.limit?.note === 'string' && !!row.limit.note;
const statusOf = (row) => {
  if (isLimitRow(row)) return 'limit';
  return row && STATUSES.has(row.status) ? row.status : 'missing';
};

/** "limit of opencode@1.19.4: <note>. Fixed in <fixedIn>." as plain text. */
export const limitText = (row) => {
  const { note, fixedIn } = row?.limit || {};
  if (!note) return '';
  const where = row.target ? ` of ${row.target}` : ' of this version';
  return `limit${where}: ${note}${fixedIn ? `. Fixed in ${fixedIn}` : ''}`;
};

const STYLE = `
:root{--bg:#fbfbfa;--fg:#1c1c1a;--muted:#6b6b66;--line:#e3e2de;--card:#fff;
--pass:#1f7a3d;--pass-bg:#e6f4ea;--fail:#b3261e;--fail-bg:#fbe9e7;--skip:#6b6b66;--skip-bg:#efeeea;
--limit:#8a5300;--limit-bg:#fdf0d5;}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe8;--muted:#a3a29c;--line:#34332f;--card:#1f1e1c;
--pass:#7fd79a;--pass-bg:#173523;--fail:#ff9a8f;--fail-bg:#3d1c19;--skip:#a3a29c;--skip-bg:#2a2926;
--limit:#f2c46b;--limit-bg:#3a2c10;}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
main{max-width:1120px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:22px;margin:0 0 4px}
.meta{color:var(--muted);font-size:13px;margin:0 0 16px;overflow-wrap:anywhere}
.totals{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 16px;padding:0;list-style:none}
.totals li{padding:2px 10px;border-radius:999px;font-size:13px;font-weight:600}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--card)}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:center;vertical-align:top}
thead th{font-size:12px;color:var(--muted);font-weight:600;white-space:nowrap}
th.t,td.t{text-align:left;position:sticky;left:0;background:var(--card);white-space:nowrap;z-index:1}
td.t small{display:block;color:var(--muted);font-weight:400;white-space:normal;max-width:220px}
.pass{color:var(--pass);background:var(--pass-bg)}.fail{color:var(--fail);background:var(--fail-bg)}
.skip,.missing{color:var(--skip);background:var(--skip-bg)}.limit{color:var(--limit);background:var(--limit-bg)}
td.c{font-weight:700;min-width:36px;position:relative}
tr.d td{text-align:left;background:var(--bg);font-size:13px}
tr.d ul{margin:0;padding-left:18px}
/* Details stay readable without scrolling the grid sideways on a phone. */
.dd{position:sticky;left:10px;max-width:min(100%,calc(100vw - 54px))}tr.d li{overflow-wrap:anywhere}
tr.d code,details code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
details{margin-top:4px}summary{cursor:pointer;color:var(--muted)}
/* .sr stays inside its positioned cell; unanchored, it widened the page at 390px. */
.sr{position:absolute;left:0;top:0;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
ol.legend{padding-left:22px;color:var(--muted);font-size:13px}
.up{border:1px solid var(--line);border-radius:10px;background:var(--card);padding:12px 14px;margin:0 0 10px;overflow-wrap:anywhere}
.up h3{font-size:15px;margin:0 0 6px}.up p,.up ul{margin:4px 0;font-size:14px}.up ul{padding-left:18px}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;margin-right:6px}
.worked,.fixed{color:var(--pass);background:var(--pass-bg)}.open{color:var(--fail);background:var(--fail-bg)}
.up code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
@media (max-width:480px){main{padding:16px}th,td{padding:6px}td.t small{max-width:140px}}
`;

const cell = (row, check) => {
  const status = statusOf(row);
  const limit = status === 'limit' ? ` (${limitText(row)})` : '';
  const label = `${check.title}: ${status}${limit}${row?.detail ? ` — ${row.detail}` : ''}`;
  return `<td class="c ${status}" title="${escapeHtml(label)}"><span aria-hidden="true">${MARK[status] || '?'}</span><span class="sr">${escapeHtml(status)}</span></td>`;
};

// A limit leads with what the version cannot do and where it is fixed; a
// declared limit on a passing row says it did not reproduce this run.
const limitNote = (row) => {
  if (!row?.limit?.note) return '';
  if (isLimitRow(row)) return ` <span class="limit">${escapeHtml(limitText(row))}</span>`;
  if (row.status === 'pass') return ` <span>(declared ${escapeHtml(limitText(row))}; it did not reproduce)</span>`;
  return '';
};

const detailItem = (check, row) => `<li><strong>${escapeHtml(check.id)}</strong> ${escapeHtml(statusOf(row))}${limitNote(row)}${row?.detail ? `: <code>${escapeHtml(row.detail)}</code>` : ''}${Number.isFinite(row?.ms) && row.ms ? ` <span class="ms">(${escapeHtml(row.ms)}ms)</span>` : ''}</li>`;

const targetRows = (target, checks, rows) => {
  const byCheck = new Map(rows.filter((r) => r.target === target.target).map((r) => [r.check, r]));
  const failing = checks.filter((c) => ['fail', 'limit'].includes(statusOf(byCheck.get(c.id))) || !byCheck.has(c.id));
  const note = target.note || (target.requires ? `requires ${target.requires}` : '');
  const head = `<tr><td class="t"><strong>${escapeHtml(target.target)}</strong>${note ? `<small>${escapeHtml(note)}</small>` : ''}</td>${checks.map((c) => cell(byCheck.get(c.id), c)).join('')}</tr>`;
  const all = `<details><summary>All ${checks.length} results</summary><ul>${checks.map((c) => detailItem(c, byCheck.get(c.id))).join('')}</ul></details>`;
  const failures = failing.length ? `<ul>${failing.map((c) => detailItem(c, byCheck.get(c.id))).join('')}</ul>` : '';
  return `${head}<tr class="d"><td colspan="${checks.length + 1}"><div class="dd">${failures}${all}</div></td></tr>`;
};

// Only an https link becomes an anchor; anything else stays text.
const reference = (url) => (/^https:\/\/[^\s"<>]+$/.test(url)
  ? `<a href="${escapeHtml(url)}" rel="noopener noreferrer">${escapeHtml(url)}</a>` : escapeHtml(url));

/**
 * One upstream bug: its status, the workaround (or the planned one) and where
 * it lives, the tests that prove it, what this run's matrix saw, and the
 * upstream links as references only.
 */
const BADGE = { 'worked around': 'worked', 'fixed upstream': 'fixed' };

export const upstreamItem = (row) => {
  const worked = row?.status === 'worked around';
  const fixed = row?.status === 'fixed upstream';
  const w = row?.workaround || {};
  const where = [w.ref && `<code>${escapeHtml(w.ref)}</code>`, w.where && escapeHtml(w.where)].filter(Boolean).join(' · ');
  const tests = Array.isArray(w.tests) && w.tests.length
    ? `<ul>${w.tests.map((t) => `<li><code>${escapeHtml(t)}</code></li>`).join('')}</ul>`
    : (fixed ? '' : '<p>No test proves it yet.</p>');
  const fixedLine = fixed ? `<p><strong>Fixed upstream in ${escapeHtml(row.fixed?.version)}:</strong> ${escapeHtml(row.fixed?.verified)}</p>\n` : '';
  const label = worked ? 'Workaround' : fixed ? 'Our workaround, for older versions' : 'Planned workaround';
  const matrix = row?.matrix ? `<p><strong>This run:</strong> ${escapeHtml(row.matrix.target)} · <code>${escapeHtml(row.matrix.check)}</code> ${escapeHtml(row.matrix.observed || 'not run')}</p>` : '';
  const refs = Array.isArray(row?.references) && row.references.length
    ? `<p><strong>Upstream (reference, not the fix):</strong> ${row.references.map(reference).join(' · ')}</p>` : '';
  return `<section class="up"><h3><span class="badge ${BADGE[row?.status] || 'open'}">${BADGE[row?.status] ? escapeHtml(row.status) : 'open'}</span>${escapeHtml(row?.cli)}${row?.versions ? ` <small>${escapeHtml(row.versions)}</small>` : ''}</h3>
<p>${escapeHtml(row?.bug)}</p>
${row?.downgraded ? `<p class="open">${escapeHtml(row.downgraded)}</p>` : ''}${fixedLine}<p><strong>${label}:</strong> ${escapeHtml(w.name)}${where ? ` (${where})` : ''}</p>
${tests}${matrix}${refs}</section>`;
};

const upstreamSection = (upstream) => {
  if (!Array.isArray(upstream) || !upstream.length) return '';
  const worked = upstream.filter((r) => r.status === 'worked around').length;
  const fixed = upstream.filter((r) => r.status === 'fixed upstream').length;
  return `<h2>Upstream bugs</h2>
<p class="meta">${worked} worked around · ${fixed} fixed upstream · ${upstream.length - worked - fixed} open. A row is worked around only when its workaround is on a pushed commit and a test there proves it, and fixed upstream only when we checked the fixing release ourselves.</p>
${upstream.map(upstreamItem).join('\n')}`;
};

/** @param {object} results the document run.js writes as results.json */
export const renderMatrix = (results) => {
  const checks = Array.isArray(results?.checks) ? results.checks : [];
  const rows = Array.isArray(results?.rows) ? results.rows : [];
  const targets = Array.isArray(results?.targets) ? results.targets : [];
  const host = results?.host || {};
  const count = (s) => rows.filter((r) => statusOf(r) === s).length;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Seats compatibility</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Seats compatibility</h1>
<p class="meta">Generated ${escapeHtml(results?.generatedAt)} on ${escapeHtml(host.os)} ${escapeHtml(host.arch)}, node ${escapeHtml(host.node)} · schema ${escapeHtml(results?.schema)}</p>
<ul class="totals"><li class="pass">${count('pass')} pass</li><li class="fail">${count('fail')} fail</li><li class="limit">${count('limit')} limit</li><li class="skip">${count('skip')} skip</li></ul>
<div class="scroll">
<table>
<thead><tr><th class="t" scope="col">CLI</th>${checks.map((c, i) => `<th scope="col" title="${escapeHtml(c.title)}">${i + 1}</th>`).join('')}</tr></thead>
<tbody>
${targets.map((t) => targetRows(t, checks, rows)).join('\n')}
</tbody>
</table>
</div>
${upstreamSection(results?.upstream)}
<h2>Checks</h2>
<p class="meta">${MARK.pass} pass · ${MARK.fail} fail · ${MARK.limit} limit of that CLI version (a failure its target declares, with where it is fixed) · ${MARK.skip} skip</p>
<ol class="legend">${checks.map((c) => `<li><code>${escapeHtml(c.id)}</code> ${escapeHtml(c.title)}</li>`).join('')}</ol>
</main>
</body>
</html>
`;
};
