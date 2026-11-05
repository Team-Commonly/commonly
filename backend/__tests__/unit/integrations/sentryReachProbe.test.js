// TASK-782: a Sentry connection whose account sees no projects connected and
// granted in silence, and every search came back empty (Triage, 11-04). The
// probe answers 0 only when every reply was readable and empty; any doubt is null.
jest.mock('../../../services/hostedMcpToolDefinitions', () => ({ withHostedMcpSession: jest.fn() }));
const { withHostedMcpSession } = require('../../../services/hostedMcpToolDefinitions');
const { sentryReachProbe, SENTRY_ENTRY } = require('../../../integrations/hostedMcp/sentry');

const result = (structuredContent) => ({ content: [{ type: 'text', text: '...' }], structuredContent });
const orgs = (slugs, hasMore = false) => result({
  organizations: slugs.map((slug) => ({ slug, webUrl: null, regionUrl: 'https://us.sentry.io' })),
  hasMore, nextCursor: null,
});
const projects = (slugs, hasMore = false) => result({ projects: slugs.map((slug) => ({ slug })), hasMore, nextCursor: null });

const probeWith = (replies) => {
  const calls = [];
  const call = jest.fn(async (name, args) => {
    calls.push([name, args]);
    const reply = replies[name === 'find_organizations' ? name : `${name}:${args.organizationSlug}`];
    if (reply instanceof Error) throw reply;
    return reply;
  });
  return { calls, run: () => sentryReachProbe('token', { call }) };
};

describe('sentryReachProbe', () => {
  it('answers 0 for an org with no projects (the Triage case)', async () => {
    const { run, calls } = probeWith({ find_organizations: orgs(['commonly-vh']), 'find_projects:commonly-vh': projects([]) });
    await expect(run()).resolves.toEqual({ projects: 0 });
    expect(calls).toEqual([
      ['find_organizations', {}],
      ['find_projects', { organizationSlug: 'commonly-vh', regionUrl: 'https://us.sentry.io' }],
    ]);
  });

  it('answers 0 for an account in no org', async () => {
    const { run } = probeWith({ find_organizations: orgs([]) });
    await expect(run()).resolves.toEqual({ projects: 0 });
  });

  it('stops at the first org that has a project', async () => {
    const { run, calls } = probeWith({
      find_organizations: orgs(['empty', 'busy', 'never']),
      'find_projects:empty': projects([]),
      'find_projects:busy': projects(['backend', 'frontend']),
    });
    await expect(run()).resolves.toEqual({ projects: 2 });
    expect(calls.map(([, args]) => args.organizationSlug).filter(Boolean)).toEqual(['empty', 'busy']);
  });

  it('does not claim 0 when there are more orgs than it read', async () => {
    const { run } = probeWith({ find_organizations: orgs(['a'], true), 'find_projects:a': projects([]) });
    await expect(run()).resolves.toBeNull();
    const many = probeWith(Object.fromEntries([
      ['find_organizations', orgs(['a', 'b', 'c', 'd', 'e', 'f'])],
      ...['a', 'b', 'c', 'd', 'e', 'f'].map((slug) => [`find_projects:${slug}`, projects([])]),
    ]));
    await expect(many.run()).resolves.toBeNull();
  });

  it('answers null on any unreadable reply', async () => {
    for (const reply of [
      new Error('vendor down'),
      { isError: true, content: [{ type: 'text', text: 'no' }] },
      { content: [{ type: 'text', text: 'no structured content' }] },
      result({ organizations: 'nope', hasMore: false }),
    ]) {
      const { run } = probeWith({ find_organizations: reply });
      // eslint-disable-next-line no-await-in-loop
      await expect(run()).resolves.toBeNull();
    }
    const badProjects = probeWith({ find_organizations: orgs(['a']), 'find_projects:a': result({ projects: null }) });
    await expect(badProjects.run()).resolves.toBeNull();
  });

  it('answers null without a token', async () => {
    const call = jest.fn();
    await expect(sentryReachProbe('', { call })).resolves.toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('with no call injected, runs in one session on the Sentry entry under a 6s deadline', async () => {
    withHostedMcpSession.mockImplementation(async (_entry, _token, _ms, fn) => fn(async (name) => (
      name === 'find_organizations' ? orgs([]) : null)));
    await expect(sentryReachProbe('fresh-token')).resolves.toEqual({ projects: 0 });
    expect(withHostedMcpSession).toHaveBeenCalledWith(SENTRY_ENTRY, 'fresh-token', 6000, expect.any(Function));
    withHostedMcpSession.mockRejectedValueOnce(new Error('deadline'));
    await expect(sentryReachProbe('fresh-token')).resolves.toBeNull();
  });
});
