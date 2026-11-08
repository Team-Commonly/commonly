#!/usr/bin/env node
/**
 * Fails when a preset teaches a `commonly_*` tool that the runtime it declares
 * does not have.
 *
 * WHAT IS LEFT. This is the half of the old moltbot tool contract that never
 * depended on the openclaw submodule. ADR-021 Part B retired that submodule, so
 * the checks against the pinned extension went with it. `internal` presets still
 * resolve against the native runtime's TOOLS array in this repo, and that check
 * still guards real prompts. `openclaw` presets are skipped: their tool set no
 * longer exists anywhere this repo can read.
 *
 * EXIT CODES
 *   0  every checked name resolves
 *   1  a preset names a tool its runtime does not have
 *   2  cannot verify (a file moved, or a preset cues a runtime with no tool set)
 *
 * 2 is deliberately NOT 0. A check that cannot run must not look like a check
 * that passed.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const PRESETS_FILE = path.join(REPO_ROOT, 'backend', 'routes', 'registry', 'presets.ts');
const NATIVE_RUNTIME = path.join(REPO_ROOT, 'backend', 'services', 'nativeRuntimeService.ts');
const RETIRED_RUNTIMES = ['openclaw'];

/**
 * Blank a comment out rather than deleting it, so every later offset and
 * line-start anchor still lands where it did in the original text.
 */
const blankOut = (text) => text.replace(/[^\n]/g, ' ');

/**
 * Comments are NOT delivered to agents, and these files' comments discuss tools
 * at length, so counting one would red the build over a paragraph. String
 * contents ARE delivered: a `//` inside a prompt is prompt text, so this walks
 * the source and blanks only what sits outside a string. A ' or " string ends at
 * its line, so a quote in a regex literal cannot swallow the rest of the file.
 */
const stripComments = (src) => {
  let out = '';
  let quote = null;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      if (c === '\\') {
        out += src.slice(i, i + 2);
        i += 2;
      } else {
        if (c === quote || (c === '\n' && quote !== '`')) quote = null;
        out += c;
        i += 1;
      }
    } else if (c === "'" || c === '"' || c === '`') {
      quote = c;
      out += c;
      i += 1;
    } else if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      const close = src[i + 1] === '/' ? src.indexOf('\n', i) : src.indexOf('*/', i + 2) + 2;
      const end = close <= i + 1 ? src.length : close;
      out += blankOut(src.slice(i, end));
      i = end;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
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

/**
 * The `internal` runtime's tool surface — a hardcoded array in this repo, NOT
 * the MCP package's tool set and NOT a subset of the extension's.
 *
 * It is a third namespace that spells shared capabilities differently:
 * `commonly_read_memory` where MCP has `commonly_read_agent_memory`,
 * `commonly_read_context` where MCP has `commonly_get_context`. A
 * capability-level comparison scores those as present on both surfaces; only a
 * name-level one sees the mismatch, which is the entire reason the preset check
 * below resolves per-runtime instead of against one merged set.
 *
 * Sliced from the declaration rather than restated here, for the same reason
 * loadCyclesTrailer reads presets.ts: a restated list is another copy of the set,
 * and this file exists because copies drift.
 */
const loadNativeTools = ({ read = fs.readFileSync } = {}) => {
  const code = stripComments(read(NATIVE_RUNTIME, 'utf8'));
  const start = code.indexOf('const TOOLS = [');
  if (start === -1) throw new Error('const TOOLS not found in nativeRuntimeService.ts');
  const rest = code.slice(start);
  const end = rest.slice(1).search(/\n(?:const|export|function) /);
  const body = end === -1 ? rest : rest.slice(0, end + 1);
  const names = parseDeclaredTools(body);
  // Control: an empty or near-empty parse would report every preset name as
  // missing on `internal` — loud, and wrong. Distinguish "the array shrank" from
  // "the slice or the regex stopped matching" by refusing to proceed.
  if (names.size < 5) {
    throw new Error(
      `parsed ${names.size} tool names from nativeRuntimeService.ts's TOOLS array `
      + `(${body.length} chars sliced). The declaration shape has changed; fix the slice `
      + 'before trusting a result.',
    );
  }
  return names;
};

/**
 * The one sentence presets.ts uses to say two tools are GONE. It is matched as
 * a sentence rather than exempting the names, so a prompt that tells an agent to
 * call `commonly_pr_diff` still fails. Self-checked below: an exemption for text
 * the file no longer holds has no remaining justification.
 */
const REMOVAL_NOTICE = /\(The former [^()]*commonly_pr_diff[^()]*commonly_pr_review[^()]*tools were removed[^()]*\)/g;

/**
 * presets.ts split into its preset definitions, each with the runtime it
 * declares and every `commonly_*` name its text hands an agent.
 *
 * Comments are stripped FIRST, and that is load-bearing rather than tidy. Three
 * of the file's twenty names live only in `//` comments — including
 * `commonly_save_my_memory`, which appears in call-with-parens shape inside a
 * comment and nowhere else. So the "names in `name(` position" set is not a
 * subset of the agent-facing set; it both admits a comment and, more
 * importantly, drops real instructions. social-amplifier's prompt says "Only
 * post final conversational content via commonly_post_message" — an instruction
 * to call a tool, written as a sentence, with no parens. It is also the ONLY
 * tool named by either `internal` preset, so a call-position check would cover
 * zero of the presets on the runtime whose namespace actually differs.
 */
const BLOCK_ID = /^ {4}id: (['"`])([^'"`]+)\1/;

const parsePresets = (source) => {
  const code = stripComments(source);
  const lines = code.split('\n');
  const starts = [];
  lines.forEach((line, i) => {
    if (!/^ {4}id:/.test(line)) return;
    // An id in a shape this cannot read would merge its preset into the one above.
    if (!BLOCK_ID.test(line)) throw new Error(`preset boundary at line ${i + 1} has no readable id: ${line.trim()}`);
    starts.push(i);
  });

  // Control, same shape as the empty-parse guard above: zero or a handful of
  // blocks means the file's indentation or shape moved, and a check that looks
  // at almost nothing passes almost everything.
  if (starts.length < 20) {
    throw new Error(
      `parsed ${starts.length} preset definitions from presets.ts (expected 30+). `
      + 'The block shape has changed; fix parsePresets before trusting a result.',
    );
  }

  return starts.map((start, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : lines.length;
    const body = lines.slice(start, end).join('\n');
    const id = body.match(BLOCK_ID)[2];
    const runtimes = [...new Set([...body.matchAll(/\bruntime: (['"`])([a-z-]+)\1/g)].map((m) => m[2]))];
    if (runtimes.length !== 1) {
      throw new Error(
        `preset '${id}' declares ${runtimes.length} distinct runtimes (${runtimes.join(', ') || 'none'}). `
        + 'This check resolves tool names against exactly one runtime per preset; '
        + 'a block with none or several needs a deliberate rule, not a guess.',
      );
    }
    return {
      id,
      line: start + 1,
      runtime: runtimes[0],
      names: [...new Set(body.replace(REMOVAL_NOTICE, '').match(/commonly_[a-z_]+/g) || [])],
      hasRemovalNotice: body.search(REMOVAL_NOTICE) !== -1,
    };
  });
};

/**
 * Does every tool a preset teaches exist on the runtime that preset declares?
 *
 * This is the check the row TASK-087 was filed for. presets.ts ships heartbeat
 * and soul prompts to real seats, naming twenty distinct tools, and nothing read
 * them at the name level — this script read exactly one symbol out of the file
 * (CYCLES_REFLECTION_TRAILER) and nothing else.
 *
 * Correct today, and correct by placement rather than by anything that checks:
 * `commonly_create_post` exists on openclaw and on neither other surface, and
 * all five of its sites happen to sit in `runtime: 'openclaw'` presets. Flip one
 * preset to `internal` and every woken seat reads a prompt teaching a tool its
 * driver does not have, with nothing red.
 *
 * The blast radius is a wasted turn rather than a bad write — the native
 * dispatcher's `default` returns `unknown_tool`, so that surface fails closed
 * and legibly. This check is worth its weight because the failure is silent, not
 * because it is dangerous.
 */
const checkPresetToolNames = ({ presets, sets, retired = [] }) => {
  if (!presets.some((p) => p.hasRemovalNotice)) {
    throw new Error(
      'presets.ts no longer mentions the removed tools. Delete REMOVAL_NOTICE rather than '
      + 'leaving it to excuse a future use.',
    );
  }

  const missing = [];
  const uncovered = [];

  presets.forEach((preset) => {
    const { names } = preset;
    // Nothing to resolve against: the runtime's tool set left with its driver.
    if (retired.includes(preset.runtime)) return;
    const set = sets[preset.runtime];
    if (!set) {
      // `claude-code` and `webhook` presets name no tools today. If one starts
      // to, that is a decision about which tool surface those runtimes expose —
      // and this check must say it cannot answer rather than skip quietly.
      if (names.length) uncovered.push({ preset, names });
      return;
    }
    names.filter((n) => !set.has(n)).forEach((tool) => missing.push({ preset, tool }));
  });

  const retiredCount = presets.filter((p) => retired.includes(p.runtime)).length;
  return { missing, uncovered, presetCount: presets.length, retiredCount };
};

const main = () => {
  let result;
  try {
    result = checkPresetToolNames({
      presets: parsePresets(fs.readFileSync(PRESETS_FILE, 'utf8')),
      sets: { internal: loadNativeTools() },
      retired: RETIRED_RUNTIMES,
    });
  } catch (err) {
    console.error(
      '[preset-tool-names] CANNOT VERIFY - could not resolve preset tool names.\n'
      + `  ${err.message}\n`
      + '  Exiting 2. The check did not run; it did not pass.',
    );
    process.exit(2);
  }

  if (result.missing.length) {
    console.error(
      `[preset-tool-names] FAIL - ${result.missing.length} tool name(s) in presets.ts `
      + 'do not exist on the runtime the preset declares:\n'
      + result.missing
        .map(({ preset, tool }) => `    ${tool}   (runtime: '${preset.runtime}', preset '${preset.id}', block opens at presets.ts:${preset.line})`)
        .join('\n'),
    );
  }
  if (result.uncovered.length) {
    console.error(
      '[preset-tool-names] CANNOT VERIFY - a preset cues tools on a runtime this check has no tool set for:\n'
      + result.uncovered
        .map(({ preset, names }) => `    '${preset.id}' (runtime: '${preset.runtime}') names ${names.join(', ')}`)
        .join('\n'),
    );
  }
  if (result.missing.length) process.exit(1);
  if (result.uncovered.length) process.exit(2);

  const checked = result.presetCount - result.retiredCount;
  console.log(
    `[preset-tool-names] OK - ${checked} of ${result.presetCount} presets checked; `
    + `${result.retiredCount} on a retired runtime (${RETIRED_RUNTIMES.join(', ')}) were skipped.`,
  );
};

if (require.main === module) main();

module.exports = {
  parsePresets, checkPresetToolNames, loadNativeTools, stripComments,
  PRESETS_FILE, RETIRED_RUNTIMES,
};
