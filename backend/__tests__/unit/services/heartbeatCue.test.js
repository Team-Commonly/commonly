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
