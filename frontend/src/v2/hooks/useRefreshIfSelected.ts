import { useCallback, useEffect, useRef } from 'react';

/**
 * A stable callback that refreshes the selected pod only when it is the pod a
 * late reply names. An add that completes after the invite dialog closed (or
 * moved to another pod) still reconciles its own pod's member list, and never
 * refreshes a different pod the person has since opened.
 */
export const useRefreshIfSelected = (
  selectedPodId: string | null,
  refresh: (() => Promise<void> | void) | undefined,
): ((podId: string) => void) => {
  const latest = useRef({ selectedPodId, refresh });
  useEffect(() => {
    latest.current = { selectedPodId, refresh };
  }, [selectedPodId, refresh]);
  return useCallback((podId: string) => {
    const { selectedPodId: current, refresh: run } = latest.current;
    if (!podId || podId !== current || !run) return;
    void run();
  }, []);
};

export default useRefreshIfSelected;
