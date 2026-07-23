export const FIRST_RUN_REOPEN_EVENT = 'commonly:reopen-first-run';

export const requestFirstRunGuide = (): void => {
  window.dispatchEvent(new Event(FIRST_RUN_REOPEN_EVENT));
};
