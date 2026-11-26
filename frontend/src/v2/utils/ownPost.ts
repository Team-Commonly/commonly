import { useSyncExternalStore } from 'react';

// Whether the signed-in person has posted a message in this page load. The
// thread notes it after a send succeeds; shell surfaces that wait for a first
// real action (the Discord card) read it without reaching into the thread.
let posted = false;
const listeners = new Set<() => void>();

export const noteOwnPost = (): void => {
  if (posted) return;
  posted = true;
  listeners.forEach((listener) => listener());
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const useOwnPostThisLoad = (): boolean => useSyncExternalStore(subscribe, () => posted, () => posted);

/** Test seam: forget a post noted in this page load. */
export const resetOwnPostForTest = (): void => { posted = false; };
