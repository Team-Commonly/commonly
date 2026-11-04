// Public seats run only on a harness version smoke-tested in its sandbox, with
// one tolerance: a stable patch release after the newest tested one, on that
// same major.minor line. Harnesses ship patches every few days, and refusing
// them refused every new BYO user on the current npm release (D245, 11-04).
// A newer minor or major, an older patch, an older line, or a prerelease still
// refuses until it is smoke-tested and added to the adapter's list.
const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;

export const isPatchAfterNewestTested = (version, tested) => {
  const installed = STABLE.exec(String(version || ''));
  const newest = STABLE.exec(String(tested[tested.length - 1] || ''));
  if (!installed || !newest) return false;
  return Number(installed[1]) === Number(newest[1])
    && Number(installed[2]) === Number(newest[2])
    && Number(installed[3]) > Number(newest[3]);
};
