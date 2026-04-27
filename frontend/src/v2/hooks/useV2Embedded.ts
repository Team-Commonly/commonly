import React, { createContext, createElement, useContext, useMemo } from 'react';

/**
 * Signals whether a legacy/feature page is being rendered inside the v2 shell.
 *
 * Embedded pages should:
 *  - Suppress their own top-level page title (the v2 feature header owns it)
 *  - Drop redundant intro/hero blocks under that title
 *  - Use /v2-prefixed navigation instead of leaving the v2 shell
 *
 * Design contract: V2FeaturePage wraps every legacy child in
 * <V2EmbeddedProvider value /> so any descendant can call useV2Embedded()
 * without prop drilling. As a fallback for components rendered outside the
 * provider but still under /v2, the hook also reads window.location.pathname.
 */
const V2EmbeddedContext = createContext<boolean>(false);

export interface V2EmbeddedProviderProps {
  children: React.ReactNode;
  value?: boolean;
}

export const V2EmbeddedProvider: React.FC<V2EmbeddedProviderProps> = ({ children, value = true }) => (
  createElement(V2EmbeddedContext.Provider, { value }, children)
);

export const useV2Embedded = (): boolean => {
  const fromContext = useContext(V2EmbeddedContext);
  // Memoize the pathname read so React doesn't recompute every render hop.
  const fromPath = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return window.location.pathname.startsWith('/v2');
  }, []);
  return fromContext || fromPath;
};

export default useV2Embedded;
