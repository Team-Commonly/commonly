// Parse v2.css into rules: { line, endLine, media, selectors[] }. No deps; handles comments, strings, nested at-rules.
import fs from 'node:fs';
const src = fs.readFileSync(process.argv[2], 'utf8');
const rules = [];
let i = 0, line = 1;
const stack = []; // at-rule preludes
let buf = '', bufLine = 1;
const adv = (n = 1) => { for (let k = 0; k < n; k++) { if (src[i] === '\n') line++; i++; } };
while (i < src.length) {
  const c = src[i];
  if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2; while (i < end) adv(); continue; }
  if (c === '"' || c === "'") { const q = c; buf += c; adv(); while (i < src.length && src[i] !== q) { if (src[i] === '\\') { buf += src[i]; adv(); } buf += src[i]; adv(); } buf += q; adv(); continue; }
  if (!buf.trim()) bufLine = line;
  if (c === '{') {
    const prelude = buf.trim(); buf = '';
    if (prelude.startsWith('@')) { stack.push(prelude); adv(); continue; }
    // declaration block: skip to matching }
    const start = bufLine; let depth = 1; adv();
    while (i < src.length && depth) { if (src[i] === '{') { depth++; console.error(`parse: nested block inside the rule at line ${start}; its inner rules are not classed`); } else if (src[i] === '}') depth--; adv(); }
    const at = stack.filter(Boolean);
    if (at.some(a => /^@(keyframes|-webkit-keyframes|font-face)/.test(a))) continue;
    const sels = []; let d = 0, cur = '';
    for (const ch of prelude) { if (ch === '(' || ch === '[') d++; if (ch === ')' || ch === ']') d--; if (ch === ',' && d === 0) { sels.push(cur.trim()); cur = ''; } else cur += ch; }
    if (cur.trim()) sels.push(cur.trim());
    rules.push({ line: start, endLine: line, media: at.join(' | '), selectors: sels.map(s => s.replace(/\s+/g, ' ')) });
    continue;
  }
  if (c === '}') { stack.pop(); buf = ''; adv(); continue; }
  if (c === ';' && buf.trim().startsWith('@')) { buf = ''; adv(); continue; }
  buf += c; adv();
}
fs.writeFileSync(process.argv[3], JSON.stringify(rules));
const n = rules.reduce((a, r) => a + r.selectors.length, 0);
console.log('rules', rules.length, 'selectors', n, 'unique', new Set(rules.flatMap(r => r.selectors)).size, 'lastLine', rules.at(-1).endLine);
