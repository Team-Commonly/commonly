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
 * WHAT IT ALSO CHECKS. That the pinned commit is contained in the branch
 * `.gitmodules` declares. That is a separate invariant on the same subject and
 * neither implies the other — see checkPinReachable. Both are reported before
 * either decides the exit code, so a failure in one never hides the other.
 *
 * EXIT CODES
 *   0  both contracts hold
 *   1  a required tool is missing, or the pin is not on the declared branch
 *   2  cannot verify (submodule not initialised, file missing/unparseable,
 *      or the declared branch could not be resolved to compare against)
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

const readGitlinkSha = ({ full = false } = {}) => {
  try {
    const out = execFileSync('git', ['ls-tree', 'HEAD', '_external/clawdbot'], {
      cwd: REPO_ROOT, encoding: 'utf8',
    });
    const sha = out.trim().split(/\s+/)[2] || '';
    if (!sha) return '(unknown)';
    return full ? sha : sha.slice(0, 10);
  } catch {
    return '(unknown)';
  }
};

/** The branch `.gitmodules` declares for the submodule, or null if none. */
const readDeclaredBranch = (gitmodulesText) => {
  const text = typeof gitmodulesText === 'string'
    ? gitmodulesText
    : fs.readFileSync(path.join(REPO_ROOT, '.gitmodules'), 'utf8');
  // Take the `branch =` that follows the clawdbot submodule header, not the
  // first one in the file — there is more than one submodule.
  const header = text.indexOf('[submodule "_external/clawdbot"]');
  if (header === -1) return null;
  const nextHeader = text.indexOf('[submodule', header + 1);
  const block = text.slice(header, nextHeader === -1 ? undefined : nextHeader);
  const m = block.match(/^\s*branch\s*=\s*(\S+)\s*$/m);
  return m ? m[1] : null;
};

/**
 * Is the pinned commit contained in the branch `.gitmodules` declares?
 *
 * This is a DIFFERENT invariant from the tool contract above, on the same
 * subject. The tool contract asks what the pin declares; this asks whether the
 * pin is reachable from the branch we claim to track. Both were violated by
 * the same five bumps, and neither implies the other: #840 pinned a commit
 * whose tool set was exactly right and which lived only on an unmerged feature
 * branch, so the tool contract passed green over a pin that a squash-merge
 * would have orphaned.
 *
 * An unreachable pin is not a cosmetic problem, though it takes a step to
 * become fatal: openclaw has `delete_branch_on_merge: false`, so the branch
 * holding an orphan survives its PR and someone has to delete it by hand.
 * After that the commit is GC-eligible, and every fresh clone and every
 * `submodules: recursive` CI job dies on
 *   fatal: Fetched in submodule path '_external/clawdbot', but it did not contain <sha>
 * which is neither loud nor legible at the surface anyone is watching. An
 * earlier version of this comment said the deletion was automatic; it is not.
 *
 * Returns { state: 'contained' | 'orphaned' | 'undetermined', detail }.
 * `undetermined` is not success — main() maps it to exit 2, same as any other
 * check that could not run.
 */
const checkPinReachable = ({ exec = execFileSync } = {}) => {
  const branch = readDeclaredBranch();
  const pin = readGitlinkSha({ full: true });
  const submodule = path.join(REPO_ROOT, '_external', 'clawdbot');

  if (!branch) {
    return { state: 'undetermined', branch, pin, detail: '.gitmodules declares no branch for _external/clawdbot' };
  }
  if (pin === '(unknown)') {
    return { state: 'undetermined', branch, pin, detail: 'could not read the gitlink sha from HEAD' };
  }

  const git = (args) => exec('git', args, { cwd: submodule, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  // Prefer the ref we already have; only reach for the network if it is absent,
  // so an offline run of a freshly-updated checkout still resolves.
  let ref = `refs/remotes/origin/${branch}`;
  try {
    git(['rev-parse', '--verify', '--quiet', ref]);
  } catch {
    try {
      git(['fetch', '--quiet', 'origin', branch]);
      ref = 'FETCH_HEAD';
    } catch (err) {
      return {
        state: 'undetermined',
        branch,
        pin,
        detail: `could not resolve or fetch origin/${branch} (${String(err.message || err).split('\n')[0]})`,
      };
    }
  }

  // Fast path, and the only one that is trustworthy in a shallow checkout:
  // if the pin IS the branch tip, containment is settled without any history.
  // Worth doing first because it is also the common case right after a bump.
  let tip = null;
  try {
    tip = String(git(['rev-parse', ref])).trim();
  } catch { /* fall through to the ancestry check */ }
  if (tip && tip === pin) {
    return { state: 'contained', branch, pin, detail: `${pin.slice(0, 10)} is the tip of ${branch}` };
  }

  // A SHALLOW repository answers the ancestry question CONFIDENTLY AND WRONG.
  // Both commits are valid objects, so git does not error — it walks from the
  // tip, hits the shallow graft (which it treats as parentless), never reaches
  // the pin, and reports "not an ancestor" with status 1. That is exactly the
  // status this function treats as a finding, so the degradation designed for
  // git failures does not catch it. Measured, same two shas both ways:
  //
  //   full clone     merge-base --is-ancestor 2ce923b6 origin/main  → 0
  //   depth-1 clone  same two shas, both objects present            → 1
  //
  // actions/checkout defaults to fetch-depth 1 and passes --depth=1 down to
  // submodules, so the default CI checkout is the shallow case. Left
  // unguarded, this check would red every pin that is not exactly the branch
  // tip — the normal resting state of a submodule pin — and tell the operator
  // to re-pin a commit that was never orphaned. Found by @sprint-review.
  //
  // Deepening here instead would mean a full-history fetch of openclaw on
  // every CI run; the caller declaring `fetch-depth: 0` pays that cost once,
  // visibly, where it can be weighed.
  try {
    if (String(git(['rev-parse', '--is-shallow-repository'])).trim() === 'true') {
      return {
        state: 'undetermined',
        branch,
        pin,
        detail: `the submodule checkout is shallow, and a shallow repo reports "not an ancestor" `
          + `for a pin it simply cannot see — set fetch-depth: 0 on the checkout to verify this`,
      };
    }
  } catch { /* older git without the flag: fall through and accept the risk */ }

  try {
    git(['merge-base', '--is-ancestor', pin, ref]);
    return { state: 'contained', branch, pin, detail: `${pin.slice(0, 10)} is an ancestor of ${branch}` };
  } catch (err) {
    // `--is-ancestor` exits 1 for "not an ancestor" and >1 for a real error.
    // Only the former is a finding; anything else means the check did not run.
    if (err && err.status === 1) {
      return { state: 'orphaned', branch, pin, detail: `${pin.slice(0, 10)} is NOT contained in ${branch}` };
    }
    return {
      state: 'undetermined',
      branch,
      pin,
      detail: `ancestry check errored (${String(err && err.message).split('\n')[0]})`,
    };
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

  // Both checks are reported before either decides the exit code. A pin can be
  // simultaneously tool-complete and unreachable (that is exactly #840), and
  // exiting on the first failure would hide whichever ran second.
  const reach = checkPinReachable();
  if (reach.state === 'orphaned') {
    console.error(
      `[moltbot-tool-contract] FAIL — the pin is not on the branch .gitmodules declares.\n`
      + `    pin              ${reach.pin}\n`
      + `    declared branch  ${reach.branch}\n`
      + `    ${reach.detail}\n\n`
      + '  The tool set at this pin may be perfectly correct — that is not what this\n'
      + '  checks. Once the branch actually holding this commit is deleted it becomes\n'
      + '  GC-eligible, and every fresh clone and `submodules: recursive` job then fails\n'
      + "  with \"did not contain <sha>\".\n"
      + '  Fix: land the commit on the declared branch and pin the sha that results.\n'
      + '  A squash-merge mints a NEW sha — re-pin to that one, do not assume the\n'
      + '  feature-branch commit survived.',
    );
  } else if (reach.state === 'undetermined') {
    console.error(
      `[moltbot-tool-contract] CANNOT VERIFY reachability — ${reach.detail}.\n`
      + '  Exiting 2, NOT 0: the tool-declaration result below stands on its own, but\n'
      + '  nothing here established that the pin is durable.',
    );
  }

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
  } else {
    console.log(
      `[moltbot-tool-contract] OK — pin ${pin} declares ${declared.size} commonly_* tools, `
      + `including all ${required.size} the fleet is instructed to call `
      + `(${[...required.keys()].join(', ')}).`,
    );
  }

  if (reach.state === 'contained') {
    console.log(`[moltbot-tool-contract] OK — ${reach.detail}, the branch .gitmodules declares.`);
  }

  // Severity order: a proven violation (1) outranks an unrun check (2) only
  // because a violation is actionable now. Both are non-zero; neither is a pass.
  if (missing.length || reach.state === 'orphaned') process.exit(1);
  if (reach.state === 'undetermined') process.exit(2);
};

if (require.main === module) main();

module.exports = {
  parseDeclaredTools, collectRequiredTools, loadCyclesTrailer, readDeclaredBranch, checkPinReachable,
  readGitlinkSha,
};
