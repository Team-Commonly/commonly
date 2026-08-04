/**
 * Is this upstream error GitHub throttling us, rather than refusing our
 * credential? GitHub overloads 403 for both, so the status code alone cannot
 * tell them apart — the headers can.
 *
 * Two callers ask this identical question and must never answer it
 * differently: `mapGitHubUpstreamError` (routes/github.ts), which decides
 * 429-retryable vs 502-not-your-fault, and `GitHubAppService.checkPatLiveness`,
 * which decides `live: null` vs `live: false`. When only the route had the
 * header test, the liveness probe reported every throttled-but-valid PAT as
 * dead — sending an operator to rotate a working credential, which is the exact
 * outcome that probe's tri-state exists to prevent (@ux-lead, msg 52320).
 *
 * It lives in its own module rather than on GitHubAppService deliberately.
 * Parked on the service, it disappeared whenever a test mocked the service —
 * which is ordinary and correct for route tests — taking a piece of pure
 * routing logic with it and turning the mapper's 502 into a 500. A predicate
 * over an HTTP status and a header bag has no business being reachable only
 * through a stateful service object.
 *
 * `x-ratelimit-remaining: '0'` is primary-quota exhaustion. `retry-after` is
 * the secondary (abuse-detection) limit — the likelier 403 on `/rate_limit`
 * specifically, since primary exhaustion does not throttle that endpoint at
 * all. Documented, not measured: the shared PAT was dead while this was
 * written, so neither header has been observed from real GitHub here.
 */
export function isRateLimitError(
  upstreamStatus: number | undefined,
  headers: Record<string, string> | undefined,
): boolean {
  if (upstreamStatus === 429) return true;
  if (upstreamStatus !== 403) return false;
  return headers?.['x-ratelimit-remaining'] === '0' || headers?.['retry-after'] !== undefined;
}

export default isRateLimitError;
// CJS compat: let require() return the named export bag, matching sibling services.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
