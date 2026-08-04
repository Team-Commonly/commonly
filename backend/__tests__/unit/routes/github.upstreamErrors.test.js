// AX audit #9: `commonly_pr_diff` reported an upstream 401 as a 500. The two
// codes carry opposite instructions — 500 says retry, 401 says stop and fix
// the credential — so a caller doing the right thing by the status retried
// forever against a fault no retry resolves. The only true signal lived in a
// `detail` string nothing machine-readable reads.
//
// These pin the mapping. The assertion that matters in every case is
// `retryable`: it is the field a caller can branch on, and it is the thing the
// old shape got backwards.

const { mapGitHubUpstreamError } = require('../../../routes/github');

const LABELS = { fallback: 'Failed to fetch pull diff', notFound: 'Pull request not found' };

// Shaped like a real axios error, since that is what the routes catch.
const upstream = (status, headers = {}) => ({
  message: `Request failed with status code ${status}`,
  response: { status, headers },
});

describe('mapGitHubUpstreamError', () => {
  it('maps an upstream 401 to a non-retryable 502, not a 500', () => {
    const { status, body } = mapGitHubUpstreamError(upstream(401), LABELS);
    // The whole finding: this used to be 500, which instructs a retry.
    expect(status).toBe(502);
    expect(body.code).toBe('github_credential_rejected');
    expect(body.upstreamStatus).toBe(401);
    expect(body.retryable).toBe(false);
    // The upstream status survives in a machine-readable field rather than
    // only inside the human-readable detail string.
    expect(body.detail).toBe('Request failed with status code 401');
  });

  it('reports a credential rejection as 502 and does not pass the 401 through', () => {
    // A bare 401 would relocate the false model onto the caller's own token:
    // the caller's auth is fine, it is our server credential GitHub refused.
    //
    // The positive assertion is load-bearing (@ux-lead, msg 52276): with only
    // `not.toBe(401)` this test stayed green under the exact 502→500 mutation
    // it reads like it guards, because a 500 isn't a 401 either. A test that
    // pins what a value ISN'T has to pin what it IS, or it passes under the
    // bug.
    const { status, body } = mapGitHubUpstreamError(upstream(401), LABELS);
    expect(status).toBe(502);
    expect(status).not.toBe(401);
    expect(String(body.error)).toMatch(/server credential/i);
  });

  it('maps a plain upstream 403 the same way (also a credential fault)', () => {
    const { status, body } = mapGitHubUpstreamError(upstream(403), LABELS);
    expect(status).toBe(502);
    expect(body.code).toBe('github_credential_rejected');
    expect(body.retryable).toBe(false);
  });

  it('distinguishes a rate-limited 403 from a rejected credential', () => {
    // GitHub overloads 403 for rate limiting; the remaining-budget header is
    // the only thing that separates them, and they need opposite advice.
    const { status, body } = mapGitHubUpstreamError(
      upstream(403, { 'x-ratelimit-remaining': '0' }),
      LABELS,
    );
    expect(status).toBe(429);
    expect(body.code).toBe('github_rate_limited');
    expect(body.retryable).toBe(true);
  });

  it('maps an upstream 429 to 429, retryable', () => {
    const { status, body } = mapGitHubUpstreamError(upstream(429), LABELS);
    expect(status).toBe(429);
    expect(body.retryable).toBe(true);
  });

  it('maps a genuine upstream 5xx to a retryable 502', () => {
    const { status, body } = mapGitHubUpstreamError(upstream(503), LABELS);
    expect(status).toBe(502);
    expect(body.code).toBe('github_upstream_error');
    expect(body.upstreamStatus).toBe(503);
    // This one IS worth retrying — the flag has to move, or it is decorative.
    expect(body.retryable).toBe(true);
  });

  it('keeps 404 as 404 and uses the caller-supplied noun', () => {
    const { status, body } = mapGitHubUpstreamError(upstream(404), LABELS);
    expect(status).toBe(404);
    expect(body.error).toBe('Pull request not found');
    expect(body.retryable).toBe(false);

    const issue = mapGitHubUpstreamError(upstream(404), { fallback: 'x', notFound: 'Issue not found' });
    expect(issue.body.error).toBe('Issue not found');
  });

  it('still returns 500 when there is no upstream response at all', () => {
    // The one honest 500: our own bug, no GitHub verdict to report.
    const { status, body } = mapGitHubUpstreamError(new Error('socket hang up'), LABELS);
    expect(status).toBe(500);
    expect(body.code).toBe('github_proxy_error');
    expect(body.error).toBe('Failed to fetch pull diff');
    expect(body.upstreamStatus).toBeUndefined();
  });

  it('never reports a credential rejection as retryable, across every auth status', () => {
    // The single invariant this file exists to defend.
    [401, 403].forEach((s) => {
      expect(mapGitHubUpstreamError(upstream(s), LABELS).body.retryable).toBe(false);
    });
  });

  it('carries detail on every branch, including 404', () => {
    // Every call site logs `mapped.body.detail`. The 404 branch used to omit
    // it, so the commonest failure logged `github_not_found undefined`
    // (@sprint-review) — the diagnostic went blank exactly where it is read
    // most. Asserted across the whole taxonomy rather than on 404 alone, so a
    // future branch cannot reintroduce the hole somewhere else.
    [404, 429, 401, 403, 500, 503].forEach((s) => {
      const { body } = mapGitHubUpstreamError(upstream(s), LABELS);
      expect(body.detail).toBe(`Request failed with status code ${s}`);
    });
    // The no-upstream-response case has only our own message to report.
    expect(mapGitHubUpstreamError(new Error('socket hang up'), LABELS).body.detail)
      .toBe('socket hang up');
  });
});
