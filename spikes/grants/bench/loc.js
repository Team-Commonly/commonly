#!/usr/bin/env node
/**
 * Non-blank, non-comment lines. A line counts unless it is blank or is wholly
 * inside a comment (`//` line comments, `/* … *\/` blocks, which both languages
 * share). A code line with a trailing comment counts as code. Strings that
 * contain comment markers are not parsed, which is accurate for these files
 * because no line opens with a comment marker inside a string.
 *
 * Usage: node bench/loc.js <file>...
 */
import { readFileSync } from 'node:fs';

const count = (text) => {
  let inBlock = false;
  let code = 0;
  for (const raw of text.split('\n')) {
    let line = raw.trim();
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end < 0) continue;
      inBlock = false;
      line = line.slice(end + 2).trim();
    }
    if (line.startsWith('/*')) {
      const end = line.indexOf('*/', 2);
      if (end < 0) { inBlock = true; continue; }
      line = line.slice(end + 2).trim();
    }
    if (!line || line.startsWith('//') || line.startsWith('#!')) continue;
    code += 1;
  }
  return code;
};

let total = 0;
for (const file of process.argv.slice(2)) {
  const text = readFileSync(file, 'utf8');
  const n = count(text);
  total += n;
  console.log(`${String(n).padStart(5)}  ${String(text.split('\n').length - 1).padStart(5)} physical  ${file}`);
}
console.log(`${String(total).padStart(5)}  total code lines`);
