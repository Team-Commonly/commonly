/**
 * Render a results document as one self-contained HTML page: no external
 * scripts, styles, fonts or images, so the artifact opens anywhere and a
 * Pages deploy needs nothing but this file. Every value from the results is
 * escaped — detail strings carry CLI and provider output.
 */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

const MARK = { pass: '✓', fail: '✗', skip: '–' };
const STATUSES = new Set(['pass', 'fail', 'skip']);
const statusOf = (row) => (row && STATUSES.has(row.status) ? row.status : 'missing');

const STYLE = `
:root{--bg:#fbfbfa;--fg:#1c1c1a;--muted:#6b6b66;--line:#e3e2de;--card:#fff;
--pass:#1f7a3d;--pass-bg:#e6f4ea;--fail:#b3261e;--fail-bg:#fbe9e7;--skip:#6b6b66;--skip-bg:#efeeea;}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe8;--muted:#a3a29c;--line:#34332f;--card:#1f1e1c;
--pass:#7fd79a;--pass-bg:#173523;--fail:#ff9a8f;--fail-bg:#3d1c19;--skip:#a3a29c;--skip-bg:#2a2926;}}
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
.skip,.missing{color:var(--skip);background:var(--skip-bg)}
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
@media (max-width:480px){main{padding:16px}th,td{padding:6px}td.t small{max-width:140px}}
`;

const cell = (row, check) => {
  const status = statusOf(row);
  const label = `${check.title}: ${status}${row?.detail ? ` — ${row.detail}` : ''}`;
  return `<td class="c ${status}" title="${escapeHtml(label)}"><span aria-hidden="true">${MARK[status] || '?'}</span><span class="sr">${escapeHtml(status)}</span></td>`;
};

const detailItem = (check, row) => `<li><strong>${escapeHtml(check.id)}</strong> ${escapeHtml(statusOf(row))}${row?.detail ? `: <code>${escapeHtml(row.detail)}</code>` : ''}${Number.isFinite(row?.ms) && row.ms ? ` <span class="ms">(${escapeHtml(row.ms)}ms)</span>` : ''}</li>`;

const targetRows = (target, checks, rows) => {
  const byCheck = new Map(rows.filter((r) => r.target === target.target).map((r) => [r.check, r]));
  const failing = checks.filter((c) => statusOf(byCheck.get(c.id)) === 'fail' || !byCheck.has(c.id));
  const note = target.note || (target.requires ? `requires ${target.requires}` : '');
  const head = `<tr><td class="t"><strong>${escapeHtml(target.target)}</strong>${note ? `<small>${escapeHtml(note)}</small>` : ''}</td>${checks.map((c) => cell(byCheck.get(c.id), c)).join('')}</tr>`;
  const all = `<details><summary>All ${checks.length} results</summary><ul>${checks.map((c) => detailItem(c, byCheck.get(c.id))).join('')}</ul></details>`;
  const failures = failing.length ? `<ul>${failing.map((c) => detailItem(c, byCheck.get(c.id))).join('')}</ul>` : '';
  return `${head}<tr class="d"><td colspan="${checks.length + 1}"><div class="dd">${failures}${all}</div></td></tr>`;
};

/** @param {object} results the document run.js writes as results.json */
export const renderMatrix = (results) => {
  const checks = Array.isArray(results?.checks) ? results.checks : [];
  const rows = Array.isArray(results?.rows) ? results.rows : [];
  const targets = Array.isArray(results?.targets) ? results.targets : [];
  const host = results?.host || {};
  const count = (s) => rows.filter((r) => r.status === s).length;
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
<ul class="totals"><li class="pass">${count('pass')} pass</li><li class="fail">${count('fail')} fail</li><li class="skip">${count('skip')} skip</li></ul>
<div class="scroll">
<table>
<thead><tr><th class="t" scope="col">CLI</th>${checks.map((c, i) => `<th scope="col" title="${escapeHtml(c.title)}">${i + 1}</th>`).join('')}</tr></thead>
<tbody>
${targets.map((t) => targetRows(t, checks, rows)).join('\n')}
</tbody>
</table>
</div>
<h2>Checks</h2>
<ol class="legend">${checks.map((c) => `<li><code>${escapeHtml(c.id)}</code> ${escapeHtml(c.title)}</li>`).join('')}</ol>
</main>
</body>
</html>
`;
};
