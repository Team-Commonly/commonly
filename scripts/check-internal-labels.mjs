#!/usr/bin/env node
// Refuses team-internal labels on the lines a PR adds: ledger ids (D followed
// by two or three digits) and the internal role name "Cofounder". This is a
// public repo, and a comment that cites an id the reader can't open tells them
// nothing; it should say the reason instead. Only added lines are read, so the
// labels already on main don't fail anyone; they are being swept separately.
//
//   node scripts/check-internal-labels.mjs --base <sha>   # diff <sha>..HEAD
//   node scripts/check-internal-labels.mjs --diff <file>  # a saved unified diff
//
// A real hit (a product name that happens to look like an id) goes in
// .internal-labels-allow as "<path> <token>".
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SCOPE = ['backend/', 'cli/src/', 'frontend/src/', 'packages/', 'docs/'];
// Vendored third-party skills are copied in as they are.
const SKIP = /(^|\/)node_modules\/|^backend\/commonly-bundled-skills\/|\.(png|jpe?g|gif|svg|ico|woff2?|lock)$|package-lock\.json$/;

// Not inside a word, a hex colour ("#D215") or a cell reference ("A1:D40",
// "D$54").
const LEDGER_ID = /(?<![#\w$:])D(\d{2,3})(?![\w$]|:\$?[A-Z])/g;
// ADR decisions top out at D13 today and ledger rows run past D300, so an
// ADR's own numbering ("### D10", "predates D17") stays below this.
const FIRST_LEDGER_ID = 20;
// "ADR-018 D12" names a decision inside an ADR, not a ledger row.
const ADR_DECISION = /ADR-\d{3}[ ,§]*D\d+/g;
const ROLE = /\bco-?founder\b/gi;

export const inScope = (file) => SCOPE.some((dir) => file.startsWith(dir)) && !SKIP.test(file);

export const parseAllowlist = (text = '') => new Set(
  text.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split(/\s+/).slice(0, 2).join(' ')),
);

export function findLabels(diffText, allow = new Set()) {
  const hits = [];
  let file = null;
  let line = 0;
  // Lines left in the current hunk, from its "@@ -a,b +c,d @@" header. Inside
  // a hunk every line is content, even one that reads "+++ x" or "@@".
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of diffText.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (raw.startsWith('-')) { oldLeft -= 1; continue; }
      if (raw.startsWith(' ') || raw === '') { oldLeft -= 1; newLeft -= 1; line += 1; continue; }
      if (!raw.startsWith('+')) continue;
      newLeft -= 1;
      const text = raw.slice(1);
      if (file && inScope(file)) {
        const found = [
          ...[...text.replace(ADR_DECISION, ' ').matchAll(LEDGER_ID)]
            .filter((m) => Number(m[1]) >= FIRST_LEDGER_ID).map((m) => m[0]),
          ...[...text.matchAll(ROLE)].map((m) => m[0]),
        ];
        for (const token of found) {
          if (!allow.has(`${file} ${token}`)) hits.push({ file, line, token, text: text.trim() });
        }
      }
      line += 1;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const path = raw.slice(4).trim();
      file = path === '/dev/null' ? null : path.replace(/^b\//, '');
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      line = Number(hunk[2]);
      newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
    }
  }
  return hits;
}

const main = () => {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
  let diffText;
  if (opt('--diff')) diffText = readFileSync(opt('--diff'), 'utf8');
  else if (opt('--base')) {
    diffText = execFileSync('git', ['diff', '--no-color', '--find-renames', '-U0', `${opt('--base')}`, 'HEAD', '--', ...SCOPE],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  } else {
    console.error('usage: check-internal-labels.mjs --base <sha> | --diff <file>');
    process.exit(2);
  }
  const allowPath = opt('--allow') || '.internal-labels-allow';
  const allow = parseAllowlist(existsSync(allowPath) ? readFileSync(allowPath, 'utf8') : '');
  const hits = findLabels(diffText, allow);
  for (const hit of hits) {
    console.log(`::error file=${hit.file},line=${hit.line}::"${hit.token}" is a team-internal label. Say the reason in plain words, or just delete the id if you can't, or add "${hit.file} ${hit.token}" to .internal-labels-allow if it is a real name.`);
  }
  console.log(hits.length ? `${hits.length} internal label(s) on added lines` : 'no internal labels on added lines');
  process.exit(hits.length ? 1 : 0);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
