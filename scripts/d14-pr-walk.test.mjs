// node --test scripts/d14-pr-walk.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  HEAD_REFUSAL, findCard, parkedApprovalId, refusalCode, runD14Walk, seatBranch,
} from './d14-pr-walk.mjs';

const ENV = { D14_OWNER_TOKEN: 'owner-session', D14_GITHUB_TOKEN: 'gh', D14_CONNECTION_ID: 'c'.repeat(24) };
const id = (n) => String(n).padStart(24, '0');

test('helpers read the broker and card shapes', () => {
  assert.equal(seatBranch('u1', '42', 'byo'), 'seat/u1/d14-byo-42');
  assert.equal(parkedApprovalId({ status: 'pending_approval', approvalId: id(7) }), id(7));
  assert.equal(parkedApprovalId({ status: 'ok' }), null);
  assert.equal(refusalCode({ error: HEAD_REFUSAL }), HEAD_REFUSAL);
  assert.equal(refusalCode({ rpcError: 'grant_revoked: gone' }), 'grant_revoked');
  const cards = [{ toolCall: { tool: 'github.commit_files', summary: { head: 'seat/a/x' } }, agentName: 'a' }];
  assert.ok(findCard(cards, { tool: 'github.commit_files', head: 'seat/a/x' }));
  assert.equal(findCard(cards, { tool: 'github.create_pull_request' }), undefined);
});

test('refuses to start without its env', async () => {
  await assert.rejects(runD14Walk({ base: 'http://x', env: {}, stateDir: mkdtempSync(path.join(tmpdir(), 'd14-')), log: () => {} }), /missing env/);
});

/**
 * A fake Commonly plus a fake GitHub holding the server's rules as #3475
 * ships them: grants live on invite-only pods whose installed agents are all
 * hosted or named, are addressed by `grant_<id>`, heads outside
 * seat/<caller>/ refuse branch_not_owned_by_seat before parking, refusals come
 * back as isError content, and only an owner's approval writes to GitHub.
 * `broken` switches one rule off, to prove the walk notices.
 */
const fakeWorld = (broken = {}) => {
  const s = {
    pods: {}, grants: {}, pending: [], branches: new Set(), pulls: [], issues: {}, tasks: [],
    deleted: [], seq: 100, tokens: {},
  };
  const next = () => id((s.seq += 1));
  const json = (status, data) => new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const runParked = (row) => {
    if (row.tool === 'github.commit_files') s.branches.add(row.args.branch);
    if (row.tool === 'github.create_pull_request') {
      s.pulls.push({ number: s.pulls.length + 1, head: { ref: row.args.head }, base: { ref: row.args.base }, state: 'open' });
    }
    if (row.after) row.after();
  };
  const memberOf = (podId, userId) => s.pods[podId].members.find((m) => m._id === userId);
  /** The broker: park or refuse, as the given caller. */
  const brokerCall = (grantId, callerId, name, args, podId) => {
    const grant = s.grants[grantId];
    if (!grant || grant.revoked) return { error: 'grant_not_found' };
    if (name === 'github.get_issue') return { title: `D14 walk ${s.issues[7]?.title?.split(' ').pop()}`, body: s.issues[7]?.body };
    const head = args.head || args.branch;
    if (!broken.mainHeadParks && !head.startsWith(`seat/${callerId}/`)) {
      if (broken.refusedCallLeavesCard) s.pending.push({ id: next(), tool: name, args, agentName: 'x', podId });
      return { error: HEAD_REFUSAL };
    }
    const row = { id: next(), tool: name, args, agentName: memberOf(podId, callerId)?.username, podId };
    if (broken.leakBeforeApproval) runParked(row);
    s.pending.push(row);
    return { status: 'pending_approval', approvalId: row.id };
  };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : {};
    const auth = (init.headers?.Authorization || '').replace('Bearer ', '');
    const p = u.pathname;
    if (u.host === 'api.github.com') {
      if (method === 'POST' && p.endsWith('/issues')) { s.issues[7] = body; return json(201, { number: 7 }); }
      if (method === 'GET' && p.includes('/branches/')) return json(s.branches.has(decodeURIComponent(p.split('/branches/')[1])) ? 200 : 404, {});
      if (method === 'GET' && p.endsWith('/pulls')) {
        const head = u.searchParams.get('head').split(':')[1];
        return json(200, s.pulls.filter((pr) => pr.head.ref === head));
      }
      if (method === 'PATCH' || method === 'DELETE') { s.deleted.push(`${method} ${p}`); return json(method === 'DELETE' ? 204 : 200, {}); }
    }
    if (p === '/api/auth/user') return json(200, { _id: id(1) });
    if (p === '/api/integrations/user/all') return json(200, [{ _id: ENV.D14_CONNECTION_ID, type: 'github-app', status: 'connected', config: { owner: 'acme', repo: 'walk' } }]);
    if (p === '/api/pods' && method === 'POST') {
      const podId = next();
      s.pods[podId] = { joinPolicy: body.joinPolicy || 'open', members: [], agents: [] };
      return json(201, { _id: podId });
    }
    if (/^\/api\/pods\/\w+$/.test(p) && method === 'GET') return json(200, { members: s.pods[p.split('/')[3]].members });
    if (/^\/api\/pods\/\w+$/.test(p) && method === 'DELETE') { s.deleted.push(`pod ${p.split('/')[3]}`); return json(200, {}); }
    if (p === '/api/registry/install') {
      const userId = next();
      s.pods[body.podId].members.push({ _id: userId, username: body.agentName, isBot: true });
      s.pods[body.podId].agents.push({ userId, agentName: body.agentName, runtimeType: body.config.runtime.runtimeType });
      return json(201, {});
    }
    if (p.endsWith('/runtime-tokens')) {
      const [, , , , podId, , agentName] = p.split('/');
      const agent = s.pods[podId].agents.find((a) => a.agentName === agentName);
      s.tokens[`seat-token-${agent.userId}`] = { userId: agent.userId, podId };
      return json(200, { token: `seat-token-${agent.userId}` });
    }
    if (p === '/api/hosted/provision') return json(200, { provisioned: true });
    if (p === '/api/grants' && method === 'POST') {
      const pod = s.pods[body.target.id];
      if (body.byoAgents && body.byoConsent !== true && !broken.consentNotRequired) return json(400, { error: 'byo_consent_required' });
      if (pod.joinPolicy !== 'invite-only') return json(403, { error: 'outsider_grant_pod_joinable' });
      const named = body.byoAgents || [];
      if (pod.agents.some((a) => a.runtimeType !== 'hosted' && !named.includes(a.userId))) return json(403, { error: 'non_native_agent' });
      const grantId = `grant_${next()}`;
      s.grants[grantId] = { podId: body.target.id };
      return json(201, { _id: next(), grantId });
    }
    if (p.startsWith('/api/grants/') && method === 'DELETE') {
      const g = s.grants[p.split('/')[3]];
      if (!g) return json(404, { error: 'grant_not_found' });
      g.revoked = true; return json(200, {});
    }
    if (/^\/api\/v1\/tasks\/\w+$/.test(p) && method === 'POST') { const t = `TASK-${s.tasks.length + 1}`; s.tasks.push({ taskId: t, podId: p.split('/')[4] }); return json(201, { task: { taskId: t } }); }
    if (/^\/api\/v1\/tasks\/\w+$/.test(p) && method === 'GET') return json(200, { tasks: s.tasks.filter((t) => t.podId === p.split('/')[4]) });
    if (p.endsWith('/claim')) {
      const caller = s.tokens[auth];
      if (!caller) return json(401, {});
      if (body.continueAnyway !== true) return json(409, { error: 'unread_messages' });
      s.tasks.find((t) => t.taskId === p.split('/')[5]).claimedByUserId = caller.userId;
      return json(200, {});
    }
    if (p === '/api/approvals/pending') {
      const podId = u.searchParams.get('podId');
      return json(200, { approvals: s.pending.filter((r) => r.podId === podId).map((r) => ({ approvalId: r.id, agentName: r.agentName, toolCall: { tool: r.tool, summary: { head: r.args.head || r.args.branch, base: r.args.base } } })) });
    }
    if (p.endsWith('/resolve')) {
      const approvalId = p.split('/')[3];
      const row = s.pending.find((r) => r.id === approvalId);
      s.pending = s.pending.filter((r) => r.id !== approvalId);
      if (body.decision === 'approved' || broken.declineStillRuns) runParked(row);
      return json(200, { ok: true });
    }
    if (p.startsWith('/api/messages/')) {
      // The hosted agent: claims the task, parks the commit, and after that
      // approval parks the pull request, all on the branch it was given.
      const podId = p.split('/')[3];
      const agent = s.pods[podId].agents.find((a) => a.runtimeType === 'hosted');
      const grantId = Object.keys(s.grants).find((g) => s.grants[g].podId === podId);
      const branch = /branch "([^"]+)"/.exec(body.content)[1];
      const taskId = /board task (\S+):/.exec(body.content)[1];
      s.tasks.find((t) => t.taskId === taskId).claimedByUserId = agent.userId;
      brokerCall(grantId, agent.userId, 'github.commit_files', { branch, base: 'main', message: 'm', files: [] }, podId);
      s.pending[s.pending.length - 1].after = () => {
        brokerCall(grantId, agent.userId, 'github.create_pull_request', { title: 't', head: branch, base: 'main' }, podId);
      };
      return json(200, {});
    }
    if (p.startsWith('/api/mcp/grants/')) {
      const caller = s.tokens[auth];
      if (!caller) return json(401, { error: 'unauthorized' });
      const { name, arguments: args } = body.params;
      const out = brokerCall(p.split('/')[4], caller.userId, name, args, caller.podId);
      return json(200, { jsonrpc: '2.0', id: 1, result: { isError: Boolean(out.error), content: [{ type: 'text', text: JSON.stringify(out) }] } });
    }
    if (p.startsWith('/api/registry/agents/') || p === '/api/hosted/deprovision') { s.deleted.push(`agent ${p}`); return json(200, {}); }
    return json(404, { error: `unrouted ${method} ${p}` });
  };
  return { s, fetchImpl };
};

const walk = (world, half) => runD14Walk({
  base: 'http://commonly.test', half, env: ENV, fetchImpl: world.fetchImpl,
  stateDir: mkdtempSync(path.join(tmpdir(), 'd14-')), stamp: '1730000000000', log: () => {},
});
const failed = (steps) => steps.filter((x) => !x.ok).map((x) => x.name);

test('both halves pass when the server holds every rule, and everything is cleaned up', async () => {
  const world = fakeWorld();
  const { exitCode, steps, manifest } = await walk(world, 'both');
  assert.deepEqual(failed(steps), []);
  assert.equal(exitCode, 0);
  assert.equal(world.s.pulls.length, 2, 'the declined PR never opened; one approved PR per half');
  assert.ok(world.s.pulls.every((pr) => /^seat\/\d+\/d14-(byo|hosted)-/.test(pr.head.ref)));
  assert.equal(manifest.pods.length, 2, 'one invite-only pod per half');
  assert.ok(Object.values(world.s.grants).every((g) => g.revoked), 'every grant revoked by its grantId');
  assert.ok(manifest.pods.every((podId) => world.s.deleted.includes(`pod ${podId}`)));
  assert.equal(world.s.deleted.filter((d) => d.includes('/git/refs/heads/seat/')).length, 2);
  assert.ok(world.s.deleted.some((d) => d.includes('/issues/7')));
});

// One broken rule each: the walk must fail the step that guards it.
for (const [rule, stepName] of [
  ['mainHeadParks', 'byo boundary: a head on the default branch is refused before parking'],
  ['refusedCallLeavesCard', 'byo boundary: a head on the default branch is refused before parking'],
  ['leakBeforeApproval', 'byo: commit parks, nothing reaches GitHub until the owner approves'],
  ['declineStillRuns', 'byo boundary: a declined pull request never opens'],
  ['consentNotRequired', 'byo: seat installed and named on a prWrite grant'],
]) {
  test(`fails "${stepName}" when the server breaks ${rule}`, async () => {
    const { exitCode, steps } = await walk(fakeWorld({ [rule]: true }), 'byo');
    assert.equal(exitCode, 1);
    assert.ok(failed(steps).includes(stepName), `failed steps: ${failed(steps).join(' | ')}`);
  });
}
