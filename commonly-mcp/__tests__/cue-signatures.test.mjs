/**
 * The inline mention cues name TOOL SIGNATURES, and nothing spanned the cue
 * text and the tool schema until this file.
 *
 * WHAT WAS ALREADY COVERED, verified at `ccacf0235`:
 *   - `moltbotToolContract.test.js` requires every `commonly_*` NAME a cue
 *     mentions to be declared by the pinned openclaw extension.
 *   - `agentMentionService.wakeOnMessage.test.js:315` pins the attach_file cue
 *     as far as `commonly_attach_file({ podId: "pod-1"`.
 *   - `agentMentionService.test.js:1310` already pins ONE signature to full
 *     arity — `commonly_read_file({ podId: "pod-1", fileName })`.
 *
 * Both existing guards answer "does this name exist". Neither answers "does
 * this call still typecheck against the tool", and the two questions come
 * apart on a parameter rename: rename `filePath` to `path` in `src/tools.js`
 * and the name still exists, the prefix assertion still matches, and every
 * woken agent is taught a call the tool rejects.
 *
 * THE PARAMETER SIDE IS NOT A CROSS-REPO PROBLEM, which is why this is worth
 * building. `@commonlyai/mcp` is `commonly-mcp/` in THIS repo, so cue and
 * schema are two files one `fs.readFileSync` apart — a rename lands in a diff
 * a single suite can read. (The openclaw half genuinely is cross-repo and
 * arrives as one line of submodule hex; that is what the contract script is
 * for, and it is why the openclaw-only names below are skipped here rather
 * than checked twice.)
 *
 * The arity half is NOT hypothetical. The comment block above the cue records
 * this exact failure already firing: the frame taught
 * `commonly_read_file({ fileName })` while the live schema required `podId`
 * too. A name-matching guard cannot see a wrong arity, so it stayed green.
 *
 * SCOPE, stated rather than implied: this reads the BRACED named-parameter
 * form `tool({ a, b })` only. `formatConsultationCue` also writes
 * `commonly_post_message(podId, question)` — a positional prose shorthand
 * whose tokens are value placeholders, not schema keys (`question` is not a
 * key; `content` is). Treating those as parameter names would red the build
 * over a sentence, so they are deliberately out. Their risk is real but it is
 * a copy question, not a schema one.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildTools } from '../src/tools.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MENTION_SERVICE = join(HERE, '..', '..', 'backend', 'services', 'agentMentionService.ts');

const tools = buildTools({ baseUrl: 'https://x.example', token: 'cm_agent_t' });
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

/**
 * Comments are not delivered to agents, and the comments around these cues
 * quote WRONG signatures on purpose as history — including the very
 * `commonly_read_file({ fileName })` arity bug this file exists to prevent.
 * Counting one would red the build over a paragraph. Blank them out rather
 * than deleting so nothing downstream shifts. (`[^:]` keeps `https://` from
 * reading as a line comment.)
 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead) => lead + m.slice(lead.length).replace(/[^\n]/g, ' '));

/**
 * Discovered from the whole (comment-stripped) file rather than from a
 * registered list of cue names: a cue added tomorrow is covered without anyone
 * remembering this file exists. An unregistered surface reads exactly like a
 * passing one, which is the failure mode all of this is about.
 */
const collectCueSignatures = () => {
  const src = stripComments(readFileSync(MENTION_SERVICE, 'utf8'));
  const found = [];
  // `\$\{podId\}` inside the cue's own template carries a `}`, so a naive
  // `[^}]*` body stops mid-signature and silently drops the tools whose first
  // argument is interpolated — which is every one that matters here.
  for (const m of src.matchAll(/commonly_([a-z_]+)\(\{((?:[^{}]|\$\{[^}]*\})*)\}\)/g)) {
    const params = m[2]
      .split(',')
      .map((p) => p.split(':')[0].trim())
      .filter(Boolean);
    found.push({ tool: `commonly_${m[1]}`, params });
  }
  return found;
};

/**
 * Named on purpose for openclaw seats, beside the MCP name for the same
 * capability — the cue ships to every driver class unconditionally. The MCP
 * package neither has nor owes these. Same exemption shape as the contract
 * script's `namedForOtherDrivers`, including the check that the list cannot
 * outlive the line justifying it.
 */
// `commonly_open_dm` is deliberately NOT here: the consultation cue names it
// bare ("or commonly_open_dm on openclaw runtimes"), never in a call form, so
// it carries no signature for this file to check. Listing it would have been
// an exemption for something that was never in scope — the inventory
// assertion below is what caught that.
const OPENCLAW_ONLY = ['commonly_read_attachment'];

describe('inline mention cues teach signatures the MCP tools accept', () => {
  const signatures = collectCueSignatures();

  it('finds signatures to check at all', () => {
    // A parser that silently matched nothing would pass every assertion below
    // by having nothing to look at — the same empty-parse hole the contract
    // script guards with its own control.
    expect(signatures.length).toBeGreaterThanOrEqual(4);
    expect(signatures.map((s) => s.tool)).toContain('commonly_attach_file');
  });

  it.each(OPENCLAW_ONLY)('%s is skipped because it is an openclaw name, and is still named by a cue', (tool) => {
    // If a cue stops naming it, the exemption is a hole with no remaining
    // justification and would excuse a future MCP use of the same name.
    expect(signatures.map((s) => s.tool)).toContain(tool);
    expect(byName[tool]).toBeUndefined();
  });

  it('names no parameter the tool does not accept', () => {
    const wrong = [];
    for (const { tool, params } of signatures) {
      if (OPENCLAW_ONLY.includes(tool)) continue;
      const props = Object.keys(byName[tool]?.inputSchema?.properties || {});
      params.filter((p) => !props.includes(p)).forEach((p) => wrong.push(`${tool}.${p}`));
    }
    expect(wrong).toEqual([]);
  });

  /**
   * Both the requirement assertion and its control read THIS, so a control
   * that passes cannot be describing a different set than the assertion walks.
   */
  const requiredPairs = signatures
    .filter((s) => !OPENCLAW_ONLY.includes(s.tool))
    .flatMap(({ tool, params }) =>
      (byName[tool]?.inputSchema?.required || []).map((param) => ({
        tool,
        param,
        named: params.includes(param),
      })));

  it('has a required-parameter set to check at all', () => {
    // The empty-parse control above guards the CUE side of the comparison.
    // This is the same control for the SCHEMA side, and it was missing:
    // a comparison has two inputs, and guarding one is not guarding the
    // comparison. Drop the `required` array from `reqWith` in `src/tools.js`
    // and the assertion below walks an empty list and passes — going inert
    // exactly where the docblock's historical `commonly_read_file({ fileName })`
    // defect lives. Measured: that mutation left all 54 tests green.
    //
    // Its mirror image is safe by accident rather than by care. The
    // properties half accumulates on a MISS, so an empty `properties` reds
    // three tests; this half accumulates on a HIT, so an empty `required`
    // reds none. Identical `|| []` / `|| {}` idiom, opposite failure
    // direction, and reading them tells you nothing about which is which.
    expect(requiredPairs.length).toBeGreaterThanOrEqual(4);
    expect(requiredPairs.map((p) => `${p.tool}.${p.param}`))
      .toContain('commonly_attach_file.filePath');
  });

  it('names every parameter the tool requires', () => {
    // The historical defect, in assertion form: the cue taught
    // `commonly_read_file({ fileName })` while `podId` was required.
    const missing = requiredPairs.filter((p) => !p.named).map((p) => `${p.tool}.${p.param}`);
    expect(missing).toEqual([]);
  });

  it('every cue-named tool that is not openclaw-only is a real MCP tool', () => {
    const unknown = signatures
      .map((s) => s.tool)
      .filter((t) => !OPENCLAW_ONLY.includes(t) && !byName[t]);
    expect(unknown).toEqual([]);
  });
});
