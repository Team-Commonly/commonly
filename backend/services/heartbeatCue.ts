/**
 * The inline heartbeat cue (ADR-012 §10.3).
 *
 * This is a CONTRACT WITH EVERY AGENT, not an incidental string, which is why
 * it lives in its own module with its own test instead of inline in
 * schedulerService. It is delivered in `payload.content` — the only part of
 * the event the model actually reads — and by §10.3's own reasoning a
 * narrative directive there beats structured metadata for behavior steering.
 * That makes it the STRONGEST heartbeat surface, and therefore the one whose
 * drift is most expensive.
 *
 * It has drifted once already, at real cost. PR #295 (2026-05-04) told agents
 * to append cycles via
 *   commonly_save_my_memory({ sections: { cycles: { append: { content } } } })
 * which that tool can express neither by section (`cycles` is not in its
 * section list) nor by shape (`additionalProperties: false`, no nested
 * `append`). Agents burned 3+ tool-call turns per heartbeat hunting for the
 * missing surface and ran out of turn budget mid-conversation — Nova missed DM
 * responses that day. The forward fix added `commonly_log_cycle`, and
 * routes/registry/presets.ts documents the whole incident above its own
 * (correct) HEARTBEAT.md trailer.
 *
 * The fix landed on the template surface and NOT on this one. The rolled-back
 * string survived here until 2026-08-04, when a seat hit it again and burned
 * the same call — so the corrected instruction lived in HEARTBEAT.md (which
 * ADR-005 wrapper seats do not even have) while the surface that wins by
 * design carried the wrong one.
 *
 * If you change the cycles-write contract, change it in THREE places:
 *   1. this module (the inline cue — the strongest surface)
 *   2. routes/registry/presets.ts (the HEARTBEAT.md trailer)
 *   3. docs/adr/ADR-012 §10.3 — the canonical cue text, which STILL showed the
 *      rolled-back call as late as 2026-08-04 with the correction sitting ~40
 *      lines downstream under "What actually shipped". This header cites §10.3
 *      as its authority, so a reader who jumps to the cited section rather than
 *      reading linearly finds the wrong instruction. That is plausibly how the
 *      original miss happened.
 *
 * An earlier version of this comment enumerated two places and claimed the
 * test beside this file made them unable to "silently diverge again". Both
 * halves were wrong, and the second was the dangerous one: the suite pins this
 * module's CONSTANT, and #295 was a DELIVERY failure — a stale string in the
 * scheduler. Reverting the scheduler to an inline literal left the suite green.
 * The `cycle-cue delivery surfaces` block in the test now pins the wiring.
 * Enumerations find gaps only for the members they name (thanks @sprint-review).
 */

// The ONLY writer for `cycles[]`. Named explicitly in the cue because the
// failure mode is an agent hunting a surface that exists under another name —
// an error that names the payload but not the owning tool reads as "you are
// calling this tool wrong" when the truth is "you are calling the wrong tool."
export const CYCLES_WRITER_TOOL = 'commonly_log_cycle';

// The truncation clause is deliberately VERSION-NEUTRAL: it states the cap and
// stops. An earlier draft said "the cap truncates silently and still returns ok,
// so confirm by reading your memory back rather than by the response" — true
// against main today, and false the moment #804 lands, because #804 adds
// `truncated`/`evicted`/`entryCap`/`retainedEntries` to the write response.
// It would then be instructing every agent, every heartbeat, to distrust the
// exact field #804 built to be trusted — the same false-model defect this cue
// exists to fix, re-introduced one clause over.
//
// A cue is a contract with every agent on every tick, so it must not assert a
// fact that another open PR is in the middle of inverting. Say what holds in
// both worlds; let the response document itself.
export const HEARTBEAT_CYCLE_CUE = '[Heartbeat tick. Before responding to the prompt below, extract one short '
  + 'takeaway from any pod activity, decision, or learning since your last cycle and call '
  + `${CYCLES_WRITER_TOOL}({ content: "<takeaway>", podId }) to append it to your \`cycles\` section. `
  + `That is the only writer for \`cycles\` — commonly_save_my_memory does not accept a \`cycles\` section. `
  + 'Keep it under 500 chars; longer content is truncated. One cycle entry per heartbeat. '
  + 'If nothing memorable happened, skip the write — empty cycles are fine.]';

/**
 * Compose the full `payload.content` for a scheduled heartbeat event.
 *
 * NOTE on the HEARTBEAT.md line: that file is a moltbot PVC artifact written
 * by the provisioner from registry.js. ADR-005 wrapper seats (local CLI,
 * cloud-codex) have no such file, so the line is a no-op for them by design —
 * it is not an error to report when it is absent.
 */
export const buildHeartbeatContent = (heartbeatPodId: unknown): string => [
  HEARTBEAT_CYCLE_CUE,
  '',
  `Scheduler heartbeat for pod ${String(heartbeatPodId)}.`,
  'Read your HEARTBEAT.md workspace file and follow it exactly.',
  'HEARTBEAT_OK is a return value — never post it or any narration to the pod chat.',
].join('\n');
