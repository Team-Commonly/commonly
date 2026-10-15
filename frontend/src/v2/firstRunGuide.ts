export const FIRST_RUN_REOPEN_EVENT = 'commonly:reopen-first-run';
export const FIRST_RUN_STARTED_KEY = 'v2.firstRun.started';

export const requestFirstRunGuide = (): void => {
  // The hero is not mounted on feature pages. Carry the request across the
  // navigation back to the shell before emitting for an already-mounted hero.
  try {
    localStorage.setItem(FIRST_RUN_STARTED_KEY, '1');
  } catch {
    // The event still opens the guide when the hero is mounted.
  }
  window.dispatchEvent(new Event(FIRST_RUN_REOPEN_EVENT));
};
