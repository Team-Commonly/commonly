/**
 * `ensurePodMatch` gates 9 runtime routes and, since propose-action, a consent
 * surface — and had **zero test references repo-wide** until now
 * (sprint-review, fleet review 2026-08-14).
 *
 * These pin the behaviour as it already was; the extraction from
 * routes/agentsRuntime.ts was a move, not a rewrite, so any failure here is a
 * regression in the move rather than a new rule.
 */

const { ensurePodMatch, resolveInstallationForPod } = require('../../../services/agentPodScope');

const POD = '6a692a1be833c668acdb84cf';
const OTHER = '6a7d154b0ec237d4b15dd28b';

// Mongo ids arrive as ObjectId-likes, not strings — every comparison in here
// goes through toString() for that reason.
const oid = (v) => ({ toString: () => v });

describe('ensurePodMatch', () => {
  test('authorizedPodIds is AUTHORITATIVE when non-empty — installations are not consulted', () => {
    // The precedence that matters: a token scoped to POD grants POD even
    // though the only installation row points elsewhere.
    expect(ensurePodMatch([{ podId: oid(OTHER) }], POD, [POD])).toBe(true);
  });

  test('a non-empty authorizedPodIds that omits the pod refuses, whatever the installs say', () => {
    expect(ensurePodMatch([{ podId: oid(POD) }], POD, [OTHER])).toBe(false);
  });

  test('with no authorizedPodIds it falls back to the installation list', () => {
    expect(ensurePodMatch([{ podId: oid(POD) }], POD, [])).toBe(true);
    expect(ensurePodMatch([{ podId: oid(OTHER) }], POD, [])).toBe(false);
  });

  test('a single installation object works as well as a list', () => {
    expect(ensurePodMatch({ podId: oid(POD) }, POD, [])).toBe(true);
    expect(ensurePodMatch({ podId: oid(OTHER) }, POD, [])).toBe(false);
  });

  test('null / empty inputs refuse rather than throwing', () => {
    // A gate that throws on a malformed caller is a 500 where a 403 belongs.
    expect(ensurePodMatch(null, POD, [])).toBe(false);
    expect(ensurePodMatch([], POD, [])).toBe(false);
    expect(ensurePodMatch(undefined, POD, undefined)).toBe(false);
  });

  test('ids compare by string value, not identity', () => {
    expect(ensurePodMatch([{ podId: oid(POD) }], oid(POD), [])).toBe(true);
  });
});

describe('resolveInstallationForPod', () => {
  test('picks the installation matching the pod', () => {
    const a = { podId: oid(OTHER), agentName: 'other' };
    const b = { podId: oid(POD), agentName: 'scout' };

    expect(resolveInstallationForPod([a, b], null, POD)).toBe(b);
  });

  test('falls back when nothing matches', () => {
    const fallback = { agentName: 'fallback' };

    expect(resolveInstallationForPod([{ podId: oid(OTHER) }], fallback, POD)).toBe(fallback);
  });

  test('falls back when the list is not an array', () => {
    const fallback = { agentName: 'fallback' };

    expect(resolveInstallationForPod(null, fallback, POD)).toBe(fallback);
  });
});
