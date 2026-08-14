/**
 * Agent pod-scope resolution — which pod a runtime caller may act in.
 *
 * Moved out of `routes/agentsRuntime.ts` unchanged. It lived there as a route
 * local for 9 call sites and had **zero test references repo-wide**
 * (sprint-review, fleet review 2026-08-14) — which was tolerable while it only
 * gated reads and posts, and stopped being tolerable when propose-action made
 * it load-bearing for a consent surface.
 *
 * It is a service, not a route helper, so the thing that enforces the scope and
 * the thing that tests it can be the same code. `proposeActionForRuntime` calls
 * these directly rather than accepting a pre-computed boolean: a route handing
 * the service `podAuthorized: true` proves only that the service honours a
 * flag, never that the caller computed it correctly — the same
 * test-a-copy-instead-of-the-original mistake one layer up.
 */

interface InstallationLike { podId?: unknown }

/**
 * Note the precedence: when `authorizedPodIds` is non-empty it is
 * AUTHORITATIVE and installations are not consulted at all. Token scope wins
 * over install rows. Preserved verbatim from the original — this is a
 * behaviour-neutral move, not a rewrite.
 */
export const ensurePodMatch = (
  installationOrList: InstallationLike | InstallationLike[] | null | undefined,
  podId: unknown,
  authorizedPodIds: unknown[] = [],
): boolean => {
  const normalizedPodId = (podId as { toString?: () => string })?.toString?.() || String(podId || '');
  if (Array.isArray(authorizedPodIds) && authorizedPodIds.length > 0) {
    return authorizedPodIds.some((id) => String(id) === normalizedPodId);
  }
  if (Array.isArray(installationOrList)) {
    return installationOrList.some((installation) => (
      (installation?.podId as { toString?: () => string })?.toString?.() === normalizedPodId
    ));
  }
  return (installationOrList?.podId as { toString?: () => string })?.toString?.() === normalizedPodId;
};

export const resolveInstallationForPod = <T extends InstallationLike>(
  installations: T[] = [],
  fallback: T,
  podId: unknown,
): T => {
  if (!Array.isArray(installations)) return fallback;
  return installations.find((installation) => (
    (installation?.podId as { toString?: () => string })?.toString?.() === String(podId)
  )) || fallback;
};

module.exports = { ensurePodMatch, resolveInstallationForPod };
export {};
