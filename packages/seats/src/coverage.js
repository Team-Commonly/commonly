/**
 * Whether the supervisor could see a run's provider traffic.
 *
 * `covered`: the run went through the loopback provider relay
 * (wire/provider-relay.js) and every response it forwarded was read for an
 * in-band refusal, so a refusal the CLI dropped settles as refusal_dropped.
 * `not_covered`: it did not, for the reason given. The CLI was not pointed at
 * the relay, ignored the override, sent no request through it, or answered with
 * a body the relay could not read. A not-covered run can still exit 0 with an
 * empty reply after a refusal, and nothing here can say otherwise. That is why
 * it is a status of its own and never reads as a pass.
 *
 * The compatibility matrix's checks return pass | fail | skip. A refusal check
 * reports a not-covered CLI as COMPAT_NOT_COVERED, a fourth status. The matrix
 * must add it to its status set and render and count it separately. It must
 * never fold it into pass, and it must not show it as `missing` either: the
 * check ran and measured something. compatRefusalStatus() is the mapping.
 */
import { failureKindOf } from './failures.js';

export const COVERAGE = Object.freeze({ COVERED: 'covered', NOT_COVERED: 'not_covered' });

/** The compat matrix status for a CLI the relay cannot cover. Same word as the coverage status. */
export const COMPAT_NOT_COVERED = COVERAGE.NOT_COVERED;

/**
 * The compat status for a refusal check: one supervised run, relay on, against
 * a fake provider scripted to refuse in-band.
 *   not covered                               → 'not_covered'
 *   covered, settled refusal_dropped          → 'pass' (the drop was caught)
 *   covered, ok, and the relay saw the refusal → 'pass' (the CLI surfaced it)
 *   covered, anything else                    → 'fail'
 */
export const compatRefusalStatus = (run) => {
  const relay = run?.relay;
  if (!relay || relay.status !== COVERAGE.COVERED) return COMPAT_NOT_COVERED;
  if (failureKindOf(run.failure) === 'refusal_dropped') return 'pass';
  if (run.outcome === 'ok' && Array.isArray(relay.refusals) && relay.refusals.length > 0) return 'pass';
  return 'fail';
};
