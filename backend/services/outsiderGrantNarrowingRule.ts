// Pure, so a test that mocks the grant census (nativeOutsiderGrantPolicy)
// still runs the real rule.

/**
 * Runtime auth's pod-write rule under the identity-wide narrowing
 * (agentRuntimeAuth.checkOutsiderGrantRuntimeNarrowing). With no narrowed pod
 * the narrowing leaves every pod write alone; with exactly one, only that
 * pod's writes pass; with two or more, none do. The install-time warning
 * (outsiderGrantNarrowingPreview) reads the same rule, so the two cannot
 * disagree about where a seat can write.
 */
export const podWriteSurvivesNarrowing = (narrowedPods: Set<string>, podId: string | null): boolean =>
  narrowedPods.size === 0 || (narrowedPods.size === 1 && podId !== null && narrowedPods.has(podId));
