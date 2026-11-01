#!/usr/bin/env node
/**
 * Last-walked guard for the docs site (TASK-020).
 *
 * Every page under `docs-site/` should carry a walk date: the day someone last
 * followed its steps against prod. The dates live in a sidecar,
 * `docs/audits/docs-last-walked.json`, not in page frontmatter, because public
 * pages carry no walk records (Sam, 2026-10-28). The sidecar maps a page path
 * (relative to `docs-site/`) to a YYYY-MM-DD date and nothing else.
 *
 * Warn-only: this script always exits 0. CI wiring comes in a later PR, once
 * the dates exist.
 *
 * Warnings:
 *   - a page has no entry in the sidecar
 *   - a page's walk date is more than 30 days before the run date
 *   - a sidecar entry names no page
 *   - a sidecar date is not a real YYYY-MM-DD
 *
 * Usage: node scripts/check-docs-last-walked.js [YYYY-MM-DD]
 * The run date defaults to today. Tests pass it explicitly.
 */

const fs = require('fs');
const path = require('path');

const MAX_AGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) return null;
  return ms;
}

/**
 * Pure check. `pages` is an array of page paths, `walked` is the parsed sidecar
 * object, `runDate` is YYYY-MM-DD. Returns an array of warning strings.
 */
function checkLastWalked({ pages, walked, runDate }) {
  const runMs = parseDate(runDate);
  if (runMs === null) throw new Error(`run date must be YYYY-MM-DD, got "${runDate}"`);

  const warnings = [];
  const pageSet = new Set(pages);

  for (const page of pages) {
    if (!Object.prototype.hasOwnProperty.call(walked, page)) {
      warnings.push({ page, message: `has no walk date in docs/audits/docs-last-walked.json` });
      continue;
    }
    const walkedMs = parseDate(walked[page]);
    if (walkedMs === null) {
      warnings.push({ page, message: `walk date "${walked[page]}" is not a real YYYY-MM-DD` });
      continue;
    }
    const ageDays = Math.round((runMs - walkedMs) / DAY_MS);
    if (ageDays > MAX_AGE_DAYS) {
      warnings.push({
        page,
        message: `last walked ${walked[page]}, ${ageDays} days before ${runDate} (limit ${MAX_AGE_DAYS})`,
      });
    }
  }

  for (const entry of Object.keys(walked)) {
    if (!pageSet.has(entry)) {
      warnings.push({ page: entry, message: `is in docs/audits/docs-last-walked.json but is not a docs-site page` });
    }
  }

  return warnings;
}

function listPages(docsDir) {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, name.name);
      if (name.isDirectory()) walk(full);
      else if (name.name.endsWith('.mdx')) out.push(path.relative(docsDir, full).split(path.sep).join('/'));
    }
  };
  walk(docsDir);
  return out.sort();
}

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const docsDir = path.join(repoRoot, 'docs-site');
  const sidecarPath = path.join(repoRoot, 'docs', 'audits', 'docs-last-walked.json');
  const runDate = process.argv[2] || new Date().toISOString().slice(0, 10);

  const walked = fs.existsSync(sidecarPath) ? JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) : {};
  const pages = listPages(docsDir);
  const warnings = checkLastWalked({ pages, walked, runDate });

  for (const w of warnings) {
    console.warn(`::warning file=docs-site/${w.page}::${w.page} ${w.message}`);
  }
  console.log(
    `${warnings.length} last-walked warning(s) across ${pages.length} docs-site page(s) at ${runDate} (warn-only, exit 0).`,
  );
}

if (require.main === module) main();

module.exports = { checkLastWalked, parseDate, MAX_AGE_DAYS };
