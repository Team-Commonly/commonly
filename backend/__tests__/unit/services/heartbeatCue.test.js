/**
 * The inline heartbeat cue is a contract with every agent (ADR-012 §10.3),
 * and it has drifted from its sibling surface once already.
 *
 * PR #295 (2026-05-04) shipped a cue naming `commonly_save_my_memory` with a
 * nested `{sections:{cycles:{append:...}}}` payload. That tool accepts neither
 * the section nor the shape, so agents burned 3+ tool-call turns per heartbeat
 * hunting for a surface that exists under another name, and ran out of turn
 * budget mid-conversation (Nova missed DM responses that day). The forward fix
 * added `commonly_log_cycle` — and landed on the HEARTBEAT.md trailer in
 * routes/registry/presets.ts but NOT on this cue, which is the surface that
 * wins by §10.3's own reasoning. It stayed wrong until 2026-08-04, when a seat
 * hit it again and burned the same call.
 *
 * So these tests pin the tool NAME and explicitly forbid the rolled-back
 * shape. A cue that merely "mentions cycles" is not enough — the failure mode
 * was naming the wrong owner, which any looser assertion would have passed.
 */

const {
  HEARTBEAT_CYCLE_CUE,
  CYCLES_WRITER_TOOL,
  buildHeartbeatContent,
} = require('../../../services/heartbeatCue');

describe('heartbeat cycle cue', () => {
  test('names commonly_log_cycle as the cycles writer', () => {
    expect(CYCLES_WRITER_TOOL).toBe('commonly_log_cycle');
    expect(HEARTBEAT_CYCLE_CUE).toContain('commonly_log_cycle({ content:');
  });

  // The specific regression. Not "does it mention cycles" — it did, while
  // being wrong about who owns them.
  test('never instructs the rolled-back save_my_memory shape (PR #295)', () => {
    expect(HEARTBEAT_CYCLE_CUE).not.toMatch(/commonly_save_my_memory\s*\(\s*\{\s*sections/);
    expect(HEARTBEAT_CYCLE_CUE).not.toMatch(/sections\s*:\s*\{\s*cycles/);
    expect(HEARTBEAT_CYCLE_CUE).not.toMatch(/append\s*:\s*\{/);
  });

  // save_my_memory may still be NAMED — saying "not this tool" is the cheapest
  // way to stop an agent hunting — but only as an exclusion, never as a call.
  test('if save_my_memory is mentioned, it is to rule it out', () => {
    if (!HEARTBEAT_CYCLE_CUE.includes('commonly_save_my_memory')) return;
    expect(HEARTBEAT_CYCLE_CUE).toMatch(/commonly_save_my_memory does not accept/);
  });

  // This test used to assert /truncates silently/ — it PINNED a claim that #804
  // inverts (that PR adds `truncated`/`evicted`/`entryCap`/`retainedEntries` to
  // the write response). A green test guarding a sentence another branch is
  // making false is worse than no test: a textual merge that keeps this file's
  // structure keeps the assertion passing while the statement it defends turns
  // into a lie told to every agent on every tick.
  //
  // So assert the durable half (the cap exists) and pin the ABSENCE of any
  // claim about how truncation is reported. Re-adding one has to argue here.
  test('states the 500-char cap without claiming how truncation is reported', () => {
    expect(HEARTBEAT_CYCLE_CUE).toContain('500');
    expect(HEARTBEAT_CYCLE_CUE).toMatch(/truncated/);
    expect(HEARTBEAT_CYCLE_CUE).not.toMatch(/silent|still returns ok|rather than by the response/i);
  });

  // ~80 tokens is the stated budget in ADR-012 §10.3; this rides on every
  // heartbeat for every agent, so an unbounded cue is a real cost.
  test('stays within the inline-cue budget', () => {
    expect(HEARTBEAT_CYCLE_CUE.length).toBeLessThan(700);
  });

  test('is a single bracketed frame, like the other inline cues', () => {
    expect(HEARTBEAT_CYCLE_CUE.startsWith('[')).toBe(true);
    expect(HEARTBEAT_CYCLE_CUE.endsWith(']')).toBe(true);
  });
});

describe('buildHeartbeatContent', () => {
  test('leads with the cue — payload.content is what the model reads', () => {
    expect(buildHeartbeatContent('pod-1').startsWith(HEARTBEAT_CYCLE_CUE)).toBe(true);
  });

  test('carries the pod id and the HEARTBEAT_OK return-value rule', () => {
    const content = buildHeartbeatContent('pod-abc');
    expect(content).toContain('Scheduler heartbeat for pod pod-abc.');
    expect(content).toContain('HEARTBEAT_OK is a return value');
  });

  test('stringifies a non-string pod id rather than emitting [object Object]', () => {
    expect(buildHeartbeatContent(12345)).toContain('pod 12345.');
  });
});

/**
 * DELIVERY guards — the tests above pin the constant, which is not the thing
 * that broke.
 *
 * PR #295 was not a wrong constant, it was a wrong *delivery*: the scheduler
 * shipped a stale inline string. Extracting the cue into a module made it
 * testable and simultaneously made bypassing it a one-line diff no test could
 * see — reverting `content: buildHeartbeatContent(...)` to an inline literal
 * left the suite at 9/9 green and `tsc --noEmit` clean. So an earlier version
 * of this file's header claimed the test "pins the tool name so the two cannot
 * silently diverge again," and that was false: it pinned the constant and
 * nothing pinned that anyone still calls it. Found by @sprint-review.
 *
 * Source-text assertions are the same tier CLAUDE.md already sanctions for
 * load-bearing CSS (`v2-layout-invariants.test.ts`) — a presence test until a
 * higher tier exists. They are deliberately about WIRING, not content: the
 * content assertions live above, and duplicating them here would just create a
 * second place to update.
 */
describe('cycle-cue delivery surfaces', () => {
  const { readFileSync } = require('fs');
  const path = require('path');
  const read = (p) => readFileSync(path.join(__dirname, '../../..', p), 'utf8');

  const ROLLED_BACK_SHAPE = /commonly_save_my_memory\s*\(\s*\{\s*sections/;

  test('schedulerService composes the cue from this module, never inline', () => {
    const src = read('services/schedulerService.ts');
    expect(src).toMatch(/buildHeartbeatContent\(/);
    expect(src).toMatch(/require\(['"]\.\/heartbeatCue['"]\)/);
    // The bypass that no test caught: an inline cue literal in the scheduler.
    expect(src).not.toMatch(/\[Heartbeat tick/);
    expect(src).not.toMatch(ROLLED_BACK_SHAPE);
  });

  test('the HEARTBEAT.md trailer names the same writer tool', () => {
    // The sibling surface that DID get the 2026-05-08 forward fix while this
    // one did not. Pinned here because it was carrying the correct string with
    // zero tests defending it — the exact state this cue was in before it broke.
    //
    // Assert the DELIVERED trailer, not the source text: presets.ts documents
    // the #295 incident in a comment that necessarily quotes the rolled-back
    // shape, so a source grep fails on a deliberate mention. Same distinction
    // the NO_REPLY sentinel makes between a bare token and a quoted one.
    const { withCyclesDirective } = require('../../../routes/registry/presets');
    const trailer = withCyclesDirective('');
    expect(trailer).toContain(CYCLES_WRITER_TOOL);
    expect(trailer).not.toMatch(ROLLED_BACK_SHAPE);
  });
});
