// Render the per-surface v2.css map from rows.json into markdown files.
import fs from 'node:fs'; import path from 'node:path';
const [,, ROWS, OUTDIR, MAIN_SHA, PROD_SHA, DATE] = process.argv;
const rows = JSON.parse(fs.readFileSync(ROWS, 'utf8'));
const SURFACES = { chat: 'Chat (main pane and pod inspector)', sidebar: 'Sidebar (nav rail, pods list, phone tab bar)', board: 'Task board', settings: 'Settings', connectors: 'Connectors', agentSettings: 'Agent settings', memory: 'Agent memory' };
const byRule = {}; for (const r of rows) (byRule[r.line] ||= []).push(r);
// Markdown code spans can't escape a backtick; a selector holding one gets a double fence.
const code = (s) => (s.includes('`') ? '`` ' + s + ' ``' : '`' + s + '`');
const flags = (r) => [r.live.length ? null : 'not seen live', r.pins.length ? 'pinned by ' + [...new Set(r.pins)].join(', ') : null, byRule[r.line].length > 1 ? `rule lists ${byRule[r.line].length} selectors` : null].filter(Boolean);
const summary = [];
for (const [s, title] of Object.entries(SURFACES)) {
  const only = rows.filter(r => r.all.length === 1 && r.all[0] === s);
  const shared = rows.filter(r => r.all.length > 1 && r.all.includes(s));
  const wholeRules = Object.values(byRule).filter(list => list.every(r => r.all.length === 1 && r.all[0] === s));
  const lines = wholeRules.reduce((a, list) => a + (list[0].end - list[0].line + 1), 0);
  const trims = only.filter(r => !byRule[r.line].every(x => x.all.length === 1 && x.all[0] === s));
  summary.push({ s, title, only: only.length, unseen: only.filter(r => !r.live.length).length, wholeRules: wholeRules.length, lines, trims: trims.length, shared: shared.length });
  let md = `# v2.css map: ${title}\n\nGenerated ${DATE} from v2.css at main \`${MAIN_SHA}\`, with live DOM read on prod \`${PROD_SHA}\`. Method and caveats: [README](README.md).\n\n`;
  md += `- **Goes with the lift:** ${only.length} selectors used only by this surface (${only.length - trims.length} in ${wholeRules.length} whole rules, about ${lines} lines; ${trims.length} sit in a rule shared with other selectors, so trim them from its list).\n`;
  md += `- **Shared, stays:** ${shared.length} selectors this surface uses that another surface also uses.\n`;
  md += `- ${only.filter(r => !r.live.length).length} of the surface-only selectors were never matched on prod in the states walked; they are classed by source references alone. Check those before deleting.\n\n`;
  md += `## Goes with the lift (surface-only)\n\nLine numbers are v2.css at \`${MAIN_SHA}\`; they shift as earlier lines change, so search by selector.\n\n`;
  for (const r of only.sort((a, b) => a.line - b.line)) { const f = flags(r); md += `- L${r.line}${r.end > r.line ? '–' + r.end : ''} ${code(r.sel)}${r.media ? ' in ' + code(r.media) : ''}${f.length ? ' — ' + f.join('; ') : ''}\n`; }
  md += `\n## Shared, stays\n\nEach line names the other surfaces that use the selector. It can go only when the last of them lifts.\n\n`;
  for (const r of shared.sort((a, b) => a.line - b.line)) md += `- L${r.line} ${code(r.sel)}${r.media ? ' in ' + code(r.media) : ''} — also ${r.all.filter(x => x !== s).join(', ')}\n`;
  fs.writeFileSync(path.join(OUTDIR, `${s}.md`), md);
}
const dead = rows.filter(r => r.all.length === 0);
let dmd = `# v2.css map: unreferenced selectors\n\nGenerated ${DATE} (main \`${MAIN_SHA}\`, prod \`${PROD_SHA}\`). These ${dead.length} selectors were never matched on prod in the states walked, and no component source names their subject class. They are deletion candidates for any PR, but grep for a dynamically built class name first. Pins name tests that read v2.css and would need updating.\n\n`;
for (const r of dead.sort((a, b) => a.line - b.line)) { const f = flags(r).filter(x => x !== 'not seen live'); dmd += `- L${r.line} ${code(r.sel)}${r.media ? ' in ' + code(r.media) : ''}${f.length ? ' — ' + f.join('; ') : ''}\n`; }
fs.writeFileSync(path.join(OUTDIR, 'unreferenced.md'), dmd);
fs.writeFileSync(path.join(OUTDIR, 'summary.json'), JSON.stringify({ summary, dead: dead.length, otherOnly: rows.filter(r => r.all.length === 1 && r.all[0] === 'other').length, total: rows.length }, null, 1));
console.log(JSON.stringify(summary, null, 1), 'dead', dead.length);
