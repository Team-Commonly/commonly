// Usage: node check-digest.js <--status|--order|--render> <expected> <generated>
//   --status  compares "Name: status" lines. <expected> is expected-status.txt, which
//             holds the §2 precedence status per initiative. Runs against keel's TASK-023
//             output once it is mapped to this shape.
//   --order   compares section titles and initiative names, in order. Runs against 565.
//   --render  compares the full section and heading lines of the digest, including the
//             motion-led "### N. Name: <motion>, <decisions>" heading from §3. Runs against 565.
// Exit 1 on any mismatch.
const fs = require('fs');

const HEADING = /^### (\d+)\. (.+)$/;

function statusLines(text) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean);
}

function order(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('## ')) out.push(line.slice(3));
    const m = HEADING.exec(line);
    if (m) out.push(m[2].slice(0, m[2].indexOf(': ')));
  }
  return out;
}

function render(text) {
  return text.split('\n').map((l) => l.trimEnd()).filter((l) => l.startsWith('## ') || HEADING.test(l));
}

function diff(label, a, b) {
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) out.push(`${label}[${i}]\n  expected: ${a[i] ?? '<missing>'}\n  got:      ${b[i] ?? '<missing>'}`);
  }
  return out;
}

const [mode, expPath, genPath] = process.argv.slice(2);
const read = (p) => fs.readFileSync(p, 'utf8');
const pick = { '--status': statusLines, '--order': order, '--render': render }[mode];
if (!pick) {
  console.error('mode must be --status, --order or --render');
  process.exit(2);
}
const problems = diff(mode.slice(2), pick(read(expPath)), pick(read(genPath)));
if (problems.length) {
  console.log(problems.join('\n'));
  process.exit(1);
}
console.log(`OK (${mode}): ${pick(read(expPath)).length} items match`);
