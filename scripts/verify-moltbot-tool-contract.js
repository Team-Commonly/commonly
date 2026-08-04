#!/usr/bin/env node
/**
 * Fails when the pinned openclaw extension does not declare a tool the
 * heartbeat trailer instructs moltbots to call.
 *
 * WHY THIS EXISTS. `_external/clawdbot`'s pin alternates between two diverged
 * openclaw lineages, and a submodule bump made to gain one tool silently
 * trades away the others. The diff is one line of hex; nothing in it names a
 * tool. Reconstructed history:
 *
 *   2026-05-09  f4b7a487  a67f0df6  BRANCH   commonly_log_cycle ARRIVES
 *   2026-05-17  b6a811bd  fc6a2231  main     LOST      (bump was for react_to_message)
 *   2026-05-21  0168f013  a67f0df6  BRANCH   RESTORED  (#418, explicitly)
 *   2026-05-24  d6e63b2e  84549161  main     LOST      (bump was for bundled-skills)
 *   2026-06-26  a3de6d07  00821479  main     current
 *
 * Between 05-24 and 2026-08-04 every moltbot was told each heartbeat to call
 * a tool its runtime did not have. Per-agent last-`cycles`-append timestamps
 * cluster inside the two branch-pinned windows and nowhere else.
 *
 * #418 proves the regression is findable by hand. It also proves finding it
 * once does not hold: an unrelated bump reverted it three days later. The
 * comment in `backend/routes/registry/presets.ts` describing this was rewritten
 * FOUR times in one afternoon, each version confidently wrong in a different
 * direction — which is the argument for a check instead of a paragraph. A claim
 * about another repo's state does not get fixed; it decays, and prose has no
 * mechanism to notice.
 *
 * WHAT IT CHECKS. Every `commonly_*` tool the cycles trailer tells an agent to
 * call must be declared in the pinned extension's tool block. Scoped to the
 * trailer on purpose: the inline mention cues in `agentMentionService.ts` are
 * being changed on #818, and a guard that straddles an open PR is a merge
 * conflict rather than a safeguard. Widening it to those cues is the obvious
 * next step once #818 lands — see WIDENING below.
 *
 * EXIT CODES
 *   0  contract holds
 *   1  a required tool is missing from the pinned extension  ← the regression
 *   2  cannot verify (submodule not initialised, file missing/unparseable)
 *
 * 2 is deliberately NOT 0. A check that cannot run must not look like a check
 * that passed — that is the failure mode this whole investigation kept hitting.
 * Callers that legitimately cannot init the submodule should special-case 2
 * loudly rather than folding it into success.
 *
 * WIDENING: add a source to REQUIRED_TOOL_SOURCES. Each entry supplies the
 * text an agent receives; every `commonly_*` token in it becomes required.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const EXTENSION_TOOLS = path.join(
  REPO_ROOT, '_external', 'clawdbot', 'extensions', 'commonly', 'src', 'tools.ts',
);

// Read the trailer from its source of truth rather than restating it, so a
// future edit that names a different tool is covered without touching this
// file. presets.ts is TypeScript; it is required through the same ts-node
// registration the backend uses when available, and read as text otherwise.
const loadCyclesTrailer = () => {
  const presetsPath = path.join(REPO_ROOT, 'backend', 'routes', 'registry', 'presets.ts');
  const raw = fs.readFileSync(presetsPath, 'utf8');
  const start = raw.indexOf('const CYCLES_REFLECTION_TRAILER = `');
  if (start === -1) throw new Error('CYCLES_REFLECTION_TRAILER not found in presets.ts');
  const bodyStart = raw.indexOf('`', start) + 1;
  const end = raw.indexOf('`;', bodyStart);
  if (end === -1) throw new Error('CYCLES_REFLECTION_TRAILER is unterminated');
  return raw.slice(bodyStart, end);
};

const REQUIRED_TOOL_SOURCES = [
  { name: 'cycles reflection trailer (presets.ts)', text: loadCyclesTrailer },
];

/** Every `commonly_*` token an agent is told to call, across all sources. */
const collectRequiredTools = () => {
  const required = new Map();
  REQUIRED_TOOL_SOURCES.forEach((source) => {
    const text = typeof source.text === 'function' ? source.text() : source.text;
    (text.match(/commonly_[a-z_]+/g) || []).forEach((tool) => {
      if (!required.has(tool)) required.set(tool, source.name);
    });
  });
  return required;
};

/**
 * Tool names DECLARED by the extension — matched on the `name:` key of a tool
 * definition, not on any occurrence of the string. A prose mention in a
 * description must not satisfy the contract.
 */
const parseDeclaredTools = (source) => new Set(
  (source.match(/name:\s*["'](commonly_[a-z_]+)["']/g) || [])
    .map((m) => m.replace(/name:\s*["']/, '').replace(/["']$/, '')),
);

const readGitlinkSha = () => {
  try {
    const out = execFileSync('git', ['ls-tree', 'HEAD', '_external/clawdbot'], {
      cwd: REPO_ROOT, encoding: 'utf8',
    });
    return (out.trim().split(/\s+/)[2] || '').slice(0, 10) || '(unknown)';
  } catch {
    return '(unknown)';
  }
};

const main = () => {
  const required = collectRequiredTools();
  const pin = readGitlinkSha();

  if (!fs.existsSync(EXTENSION_TOOLS)) {
    console.error(
      `[moltbot-tool-contract] CANNOT VERIFY — ${path.relative(REPO_ROOT, EXTENSION_TOOLS)} is absent.\n`
      + `  The submodule is pinned at ${pin} but not checked out.\n`
      + '  Run: git submodule update --init --recursive _external/clawdbot\n'
      + '  Exiting 2 (cannot verify), NOT 0 — an unrun check is not a passing one.',
    );
    process.exit(2);
  }

  const declared = parseDeclaredTools(fs.readFileSync(EXTENSION_TOOLS, 'utf8'));

  // Control: a parse that finds nothing would satisfy no assertion below by
  // emptiness, and would report every required tool as missing — a loud but
  // wrong failure. Distinguish "extension declares no tools" from "regex
  // stopped matching" by refusing to proceed on an empty parse.
  if (declared.size === 0) {
    console.error(
      '[moltbot-tool-contract] CANNOT VERIFY — parsed 0 tool declarations from a file '
      + `of ${fs.statSync(EXTENSION_TOOLS).size} bytes.\n`
      + '  The declaration shape has changed; fix parseDeclaredTools before trusting a result.',
    );
    process.exit(2);
  }

  const missing = [...required.entries()].filter(([tool]) => !declared.has(tool));

  if (missing.length) {
    console.error(
      `[moltbot-tool-contract] FAIL — the pinned openclaw extension (${pin}) declares `
      + `${declared.size} commonly_* tools and is missing ${missing.length} the fleet is told to call:\n`
      + missing.map(([tool, src]) => `    ${tool}   (required by: ${src})`).join('\n')
      + '\n\n  This is almost certainly a lineage swap, not a deleted feature. A bump made\n'
      + '  to gain one tool trades away the others; see the history in this file\'s header\n'
      + '  and the pin-skew entry in CLAUDE.md.\n'
      + '  The fix is NOT to bump in the other direction — that swaps the set back and\n'
      + '  re-drops commonly_react_to_message. End the divergence: cherry-pick onto\n'
      + '  openclaw main, then pin that.',
    );
    process.exit(1);
  }

  console.log(
    `[moltbot-tool-contract] OK — pin ${pin} declares ${declared.size} commonly_* tools, `
    + `including all ${required.size} the fleet is instructed to call `
    + `(${[...required.keys()].join(', ')}).`,
  );
};

if (require.main === module) main();

module.exports = { parseDeclaredTools, collectRequiredTools, loadCyclesTrailer };
