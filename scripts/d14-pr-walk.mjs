#!/usr/bin/env node
/**
 * D14 walk (TASK-783, #3475): an issue becomes a pull request through the
 * grant broker, once for a hosted agent and once for a named, consented BYO
 * seat. The connection owner approves every parked call. It also proves the
 * two boundaries: a head on the default branch is refused before anything
 * parks, and nothing reaches GitHub while a call waits or after a decline.
 *
 * Everything it creates is throwaway: one pod per half, one hosted agent, one webhook
 * seat, two grants, one board task, and on the test repo one issue, two seat/
 * branches and two pull requests. Cleanup runs on every outcome and removes
 * all of it (the pull requests are closed, not merged). Ids go to a manifest
 * under the state dir; tokens never do, and nothing here prints a token.
 *
 * Env (never flags, never logged):
 *   D14_OWNER_TOKEN    the connection owner's Commonly session token
 *   D14_GITHUB_TOKEN   a GitHub token that can write the test repo, used to
 *                      open the issue, check GitHub between steps and clean up
 *   D14_CONNECTION_ID  the owner's GitHub App connection on the test repo
 *                      (the App needs Contents and Pull requests read/write)
 * Flags:
 *   --base https://api.commonly.me   API origin
 *   --half both|hosted|byo           which half to walk (default both)
 *   --default-branch main            the test repo's default branch
 *
 * Exit 0 when every step of the halves walked passed, 1 otherwise. A result
 * file (D14_WALK_RESULT, default <state dir>/result.json) lists each step.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUEST_TIMEOUT_MS = 30_000;
const PARK_WAIT_MS = 6 * 60_000;
const POLL_MS = 5_000;
/** seatGithubCommit's refusal for a head outside seat/<caller>/, raised before parking. */
export const HEAD_REFUSAL = 'branch_not_owned_by_seat';
export const PR_TOOLS = ['github.get_issue', 'github.get_pull_request', 'github.commit_files', 'github.create_pull_request'];

export const seatBranch = (agentUserId, stamp, half) => `seat/${agentUserId}/d14-${half}-${stamp}`;

/** A broker reply is a parked call only when it carries an approval id. */
export const parkedApprovalId = (reply) => (
  reply && reply.status === 'pending_approval' && /^[a-f0-9]{24}$/i.test(String(reply.approvalId || ''))
    ? String(reply.approvalId) : null
);

/** The refusal code from an MCP tool reply, whichever shape carried it. */
export const refusalCode = (reply) => {
  if (!reply) return null;
  if (reply.error) return String(reply.error);
  const m = /^([a-z_]+):/.exec(String(reply.rpcError || ''));
  return m ? m[1] : null;
};

/** Find the parked card for one tool on one head, among the owner's pending cards. */
export const findCard = (approvals, { tool, head, agentName }) => (approvals || []).find((card) => (
  card?.toolCall?.tool === tool
  && (!agentName || card.agentName === agentName)
  && (!head || card.toolCall?.summary?.head === head)
));

const parseArgs = (argv) => {
  const out = { base: 'https://api.commonly.me', half: 'both', defaultBranch: 'main' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base') out.base = argv[++i];
    else if (argv[i] === '--half') out.half = argv[++i];
    else if (argv[i] === '--default-branch') out.defaultBranch = argv[++i];
  }
  if (!['both', 'hosted', 'byo'].includes(out.half)) throw new Error(`--half must be both, hosted or byo, got ${out.half}`);
  return out;
};

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

export const runD14Walk = async ({
  base, half = 'both', defaultBranch = 'main', env = process.env, fetchImpl = fetch,
  stateDir = env.D14_WALK_STATE_DIR || path.join(homedir(), '.commonly', 'state', 'd14-walk'),
  stamp = String(Date.now()), log = console.log,
}) => {
  const ownerToken = env.D14_OWNER_TOKEN;
  const ghToken = env.D14_GITHUB_TOKEN;
  const connectionId = env.D14_CONNECTION_ID;
  const missing = ['D14_OWNER_TOKEN', 'D14_GITHUB_TOKEN', 'D14_CONNECTION_ID'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`missing env: ${missing.join(', ')}`);

  const steps = [];
  const manifest = { stamp, base, pods: [], agents: [], grants: [], issue: null, branches: [], pulls: [] };
  mkdirSync(stateDir, { recursive: true });
  const writeState = () => {
    writeFileSync(path.join(stateDir, `manifest-${stamp}.json`), JSON.stringify(manifest, null, 2));
    writeFileSync(env.D14_WALK_RESULT || path.join(stateDir, 'result.json'), JSON.stringify({ stamp, base, half, steps }, null, 2));
  };

  const call = async (method, url, { token, body, headers = {} } = {}) => {
    const res = await fetchImpl(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'commonly-d14-walk', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data };
  };
  const api = (method, p, opts) => call(method, `${base}${p}`, opts);
  const gh = (method, p, body) => call(method, `https://api.github.com${p}`, {
    token: ghToken, body, headers: { Accept: 'application/vnd.github+json' },
  });

  /** One JSON-RPC tools/call on the stateless broker endpoint, as the given agent token. */
  const brokerCall = async (grantId, agentToken, tool, args) => {
    const res = await fetchImpl(`${base}/api/mcp/grants/${grantId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        'User-Agent': 'commonly-d14-walk', Authorization: `Bearer ${agentToken}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const raw = await res.text();
    if (!res.ok) {
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { /* not JSON */ }
      return { error: parsed?.error || `http_${res.status}`, httpStatus: res.status };
    }
    const line = raw.split('\n').find((l) => l.startsWith('data:'));
    const rpc = JSON.parse(line ? line.slice(5) : raw);
    if (rpc.error) return { rpcError: rpc.error.message };
    const textOut = rpc.result?.content?.[0]?.text;
    try { return JSON.parse(textOut); } catch { return { text: textOut, isError: rpc.result?.isError }; }
  };

  const step = async (name, fn) => {
    const started = Date.now();
    try {
      const detail = await fn();
      steps.push({ name, ok: true, ms: Date.now() - started, ...(detail ? { detail } : {}) });
      log(`PASS ${name}${detail ? ` - ${detail}` : ''}`);
      writeState();
      return true;
    } catch (error) {
      steps.push({ name, ok: false, ms: Date.now() - started, error: String(error.message || error).slice(0, 600) });
      log(`FAIL ${name} - ${error.message || error}`);
      writeState();
      return false;
    }
  };
  const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

  let repo = null; // { owner, repo }
  let ownerId = null;

  const pendingCards = async (podId) => {
    const r = await api('GET', `/api/approvals/pending?podId=${podId}`, { token: ownerToken });
    expect(r.status === 200, `pending ${r.status}: ${JSON.stringify(r.data)}`);
    return r.data.approvals || [];
  };
  const waitForCard = async (podId, match) => {
    const deadline = Date.now() + PARK_WAIT_MS;
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      const card = findCard(await pendingCards(podId), match);
      if (card) return card;
      // eslint-disable-next-line no-await-in-loop
      await sleep(POLL_MS);
    }
    throw new Error(`no parked ${match.tool} card${match.head ? ` for ${match.head}` : ''} within ${PARK_WAIT_MS / 1000}s`);
  };
  const decide = async (approvalId, decision) => {
    const r = await api('POST', `/api/approvals/${approvalId}/resolve`, { token: ownerToken, body: { decision } });
    expect(r.status === 200, `${decision} ${r.status}: ${JSON.stringify(r.data)}`);
    return r.data;
  };
  const branchExists = async (branch) => (await gh('GET', `/repos/${repo.owner}/${repo.repo}/branches/${encodeURIComponent(branch)}`)).status === 200;
  const pullsForHead = async (branch) => {
    const r = await gh('GET', `/repos/${repo.owner}/${repo.repo}/pulls?state=all&head=${encodeURIComponent(`${repo.owner}:${branch}`)}`);
    expect(r.status === 200, `GitHub pulls ${r.status}`);
    return r.data;
  };
  const waitForPull = async (branch) => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      const pulls = await pullsForHead(branch);
      if (pulls.length) return pulls[0];
      // eslint-disable-next-line no-await-in-loop
      await sleep(POLL_MS);
    }
    throw new Error(`no pull request on GitHub for ${branch}`);
  };
  const noPr = async (branch, label) => {
    const pulls = await pullsForHead(branch);
    expect(pulls.length === 0, `${label}: a pull request already exists for ${branch} (#${pulls[0]?.number})`);
  };

  const issueBody = (h) => `D14 walk ${stamp} (${h}). Add the file d14-walk/${h}-${stamp}.txt containing one line: "walked ${stamp}". Throwaway: closed by the walk.`;

  /** The board task the agent claims, one per half. */
  const makeTask = async (podId, h) => {
    const r = await api('POST', `/api/v1/tasks/${podId}`, {
      token: ownerToken, body: { title: `D14 walk ${h}: issue #${manifest.issue} to a pull request` },
    });
    expect(r.status < 300, `task ${r.status}: ${JSON.stringify(r.data)}`);
    const task = r.data.task || r.data;
    const taskId = String(task.taskId || task._id);
    return taskId;
  };

  try {
    await step('setup', async () => {
      const me = await api('GET', '/api/auth/user', { token: ownerToken });
      expect(me.status === 200, `owner session ${me.status}`);
      ownerId = String(me.data._id || me.data.id);
      const conns = await api('GET', '/api/integrations/user/all', { token: ownerToken });
      expect(conns.status === 200, `connections ${conns.status}`);
      const conn = (Array.isArray(conns.data) ? conns.data : conns.data.integrations || [])
        .find((c) => String(c._id) === connectionId);
      expect(conn, 'D14_CONNECTION_ID is not one of the owner\'s connections');
      expect(conn.type === 'github-app' && conn.status === 'connected', `connection is ${conn.type}/${conn.status}, not a connected github-app`);
      const owner = conn.config?.owner || conn.owner;
      const name = conn.config?.repo || conn.repo;
      expect(owner && name, 'connection names no repository');
      repo = { owner, repo: name };
      const issue = await gh('POST', `/repos/${owner}/${name}/issues`, { title: `D14 walk ${stamp}`, body: issueBody('both') });
      expect(issue.status === 201, `GitHub issue ${issue.status}: ${JSON.stringify(issue.data?.message || issue.data)}`);
      manifest.issue = issue.data.number;
      return `${owner}/${name} issue #${issue.data.number}`;
    });
    if (!manifest.issue) throw new Error('setup failed');

    // One pod per half: a grant pod must be invite-only, and its pod check
    // counts every installed agent, so a seat beside the hosted agent would
    // refuse the hosted grant.
    const makePod = async (h) => {
      const pod = await api('POST', '/api/pods', {
        token: ownerToken, body: { name: `d14-walk-${h}-${stamp}`, type: 'team', joinPolicy: 'invite-only' },
      });
      expect(pod.status < 300 && pod.data?._id, `pod ${pod.status}: ${JSON.stringify(pod.data)}`);
      const podId = String(pod.data._id);
      manifest.pods.push(podId);
      return podId;
    };

    const mintGrant = async (podId, audience, extra = {}) => {
      const r = await api('POST', '/api/grants', {
        token: ownerToken,
        body: {
          connectionId, target: { kind: 'pod', id: podId }, audience,
          writeMode: 'write-with-confirm', prWrite: true, tools: PR_TOOLS, ...extra,
        },
      });
      expect(r.status === 201 || r.status === 200, `grant ${r.status}: ${JSON.stringify(r.data)}`);
      // The route answers with the grant document; the broker and revoke
      // routes look grants up by grantId, never by the Mongo _id.
      const grantId = String(r.data?.grantId || '');
      expect(grantId.startsWith('grant_'), `grant reply carries no grantId: ${JSON.stringify(r.data).slice(0, 200)}`);
      manifest.grants.push(grantId);
      return grantId;
    };
    // A default-instance agent's username is its agent name, and the pod read
    // lists members with their ids.
    const agentUserIdFor = async (podId, agentName) => {
      const r = await api('GET', `/api/pods/${podId}`, { token: ownerToken });
      expect(r.status === 200, `pod ${r.status}`);
      const member = (r.data.members || []).find((m) => m && m.isBot && m.username === agentName);
      expect(member?._id, `${agentName} is not a member of the walk pod`);
      return String(member._id);
    };

    // ---- BYO half: a webhook seat, named on the grant with consent ----------
    if (half !== 'hosted') {
      const agentName = `d14byo${stamp.slice(-6)}`;
      let seatToken = null; let seatId = null; let grantId = null; let taskId = null; let podId = null;
      const branch = () => seatBranch(seatId, stamp, 'byo');
      await step('byo: seat installed and named on a prWrite grant', async () => {
        podId = await makePod('byo');
        const inst = await api('POST', '/api/registry/install', {
          token: ownerToken,
          body: { agentName, podId, displayName: agentName, config: { runtime: { runtimeType: 'webhook', host: 'byo' } }, scopes: [] },
        });
        expect(inst.status < 300, `install ${inst.status}: ${JSON.stringify(inst.data)}`);
        manifest.agents.push({ agentName, kind: 'byo', podId });
        const tok = await api('POST', `/api/registry/pods/${podId}/agents/${agentName}/runtime-tokens`, { token: ownerToken, body: { label: `d14-walk-${stamp}` } });
        expect(tok.status < 300 && tok.data?.token, `runtime token ${tok.status}`);
        seatToken = tok.data.token;
        seatId = await agentUserIdFor(podId, agentName);
        const unnamed = await api('POST', '/api/grants', {
          token: ownerToken,
          body: { connectionId, target: { kind: 'pod', id: podId }, audience: [seatId], writeMode: 'write-with-confirm', prWrite: true, tools: PR_TOOLS, byoAgents: [seatId] },
        });
        expect(unnamed.status >= 400 && unnamed.data?.error === 'byo_consent_required', `naming without consent was not refused: ${unnamed.status} ${JSON.stringify(unnamed.data)}`);
        grantId = await mintGrant(podId, [seatId], { byoAgents: [seatId], byoConsent: true });
        taskId = await makeTask(podId, 'byo');
        return `seat ${seatId}, grant ${grantId}`;
      });
      if (seatToken && grantId) {
        await step('byo: seat claims the task and reads the issue', async () => {
          // An agent's claim is held while it has unread pod messages unless
          // it says to go ahead; this seat reads nothing else in the pod.
          const claim = await api('POST', `/api/v1/tasks/${podId}/${taskId}/claim`, { token: seatToken, body: { continueAnyway: true } });
          expect(claim.status === 200, `claim ${claim.status}: ${JSON.stringify(claim.data)}`);
          const issue = await brokerCall(grantId, seatToken, 'github.get_issue', { issueNumber: manifest.issue });
          expect(issue && !refusalCode(issue) && JSON.stringify(issue).includes(`D14 walk ${stamp}`), `get_issue: ${JSON.stringify(issue).slice(0, 300)}`);
        });
        await step('byo boundary: a head on the default branch is refused before parking', async () => {
          const before = (await pendingCards(podId)).length;
          const pr = await brokerCall(grantId, seatToken, 'github.create_pull_request', { title: 'must not park', head: defaultBranch, base: defaultBranch });
          const commit = await brokerCall(grantId, seatToken, 'github.commit_files', {
            branch: defaultBranch, base: defaultBranch, message: 'must not park', files: [{ path: 'd14-walk/refused.txt', content: 'no\n' }],
          });
          // The exact code, so a broken grant or a 401 cannot pass for the rule.
          expect(refusalCode(pr) === HEAD_REFUSAL, `PR with head ${defaultBranch}: expected ${HEAD_REFUSAL}, got ${JSON.stringify(pr)}`);
          expect(refusalCode(commit) === HEAD_REFUSAL, `commit to ${defaultBranch}: expected ${HEAD_REFUSAL}, got ${JSON.stringify(commit)}`);
          expect((await pendingCards(podId)).length === before, 'a refused call still left a pending approval');
          return `refused ${refusalCode(pr)} / ${refusalCode(commit)}`;
        });
        let committed = false;
        await step('byo: commit parks, nothing reaches GitHub until the owner approves', async () => {
          const reply = await brokerCall(grantId, seatToken, 'github.commit_files', {
            branch: branch(), base: defaultBranch, message: `docs: d14 walk ${stamp} (byo)`,
            files: [{ path: `d14-walk/byo-${stamp}.txt`, content: `walked ${stamp}\n` }],
          });
          const approvalId = parkedApprovalId(reply);
          expect(approvalId, `commit_files did not park: ${JSON.stringify(reply)}`);
          expect(!(await branchExists(branch())), 'the branch exists on GitHub before approval');
          await decide(approvalId, 'approved');
          manifest.branches.push(branch());
          const deadline = Date.now() + 60_000;
          while (!(await branchExists(branch())) && Date.now() < deadline) await sleep(POLL_MS); // eslint-disable-line no-await-in-loop
          expect(await branchExists(branch()), 'approved commit did not create the branch');
          committed = true;
          return branch();
        });
        if (committed) {
          await step('byo boundary: a declined pull request never opens', async () => {
            const reply = await brokerCall(grantId, seatToken, 'github.create_pull_request', { title: `D14 walk ${stamp} (byo, declined)`, head: branch(), base: defaultBranch });
            const approvalId = parkedApprovalId(reply);
            expect(approvalId, `create_pull_request did not park: ${JSON.stringify(reply)}`);
            await noPr(branch(), 'while parked');
            await decide(approvalId, 'declined');
            await sleep(3_000);
            await noPr(branch(), 'after decline');
          });
          await step('byo: approved pull request opens on the seat head', async () => {
            const reply = await brokerCall(grantId, seatToken, 'github.create_pull_request', {
              title: `D14 walk ${stamp} (byo)`, head: branch(), base: defaultBranch, body: `Closes #${manifest.issue}. Throwaway; the walk closes it.`,
            });
            const approvalId = parkedApprovalId(reply);
            expect(approvalId, `create_pull_request did not park: ${JSON.stringify(reply)}`);
            await noPr(branch(), 'while parked');
            await decide(approvalId, 'approved');
            const pull = await waitForPull(branch());
            manifest.pulls.push(pull.number);
            expect(pull.head.ref.startsWith(`seat/${seatId}/`), `PR head ${pull.head.ref} is not a seat/${seatId}/ head`);
            expect(pull.base.ref === defaultBranch, `PR base ${pull.base.ref}`);
            return `#${pull.number} ${pull.head.ref}`;
          });
        }
      }
    }

    // ---- Hosted half: a Commonly-run agent driven by an @mention -------------
    if (half !== 'byo') {
      const agentName = `d14host${stamp.slice(-6)}`;
      let hostedId = null; let grantId = null; let taskId = null; let podId = null;
      await step('hosted: agent installed with a prWrite grant', async () => {
        podId = await makePod('hosted');
        const inst = await api('POST', '/api/registry/install', {
          token: ownerToken,
          body: { agentName, podId, displayName: agentName, config: { runtime: { runtimeType: 'hosted' } }, scopes: [] },
        });
        expect(inst.status < 400, `install ${inst.status}: ${JSON.stringify(inst.data)}`);
        manifest.agents.push({ agentName, kind: 'hosted', podId });
        const p = await api('POST', '/api/hosted/provision', { token: ownerToken, body: { agentName } });
        expect(p.status === 200 && p.data?.provisioned, `provision ${p.status}: ${JSON.stringify(p.data)}`);
        hostedId = await agentUserIdFor(podId, agentName);
        grantId = await mintGrant(podId, [hostedId]);
        taskId = await makeTask(podId, 'hosted');
        return `agent ${hostedId}, grant ${grantId}`;
      });
      if (hostedId && grantId) {
        const branch = seatBranch(hostedId, stamp, 'hosted');
        let commitCard = null;
        await step('hosted: the mention leads to a parked commit on its seat head', async () => {
          const m = await api('POST', `/api/messages/${podId}`, {
            token: ownerToken,
            body: {
              content: `@${agentName} Please take board task ${taskId}: claim it, then read GitHub issue #${manifest.issue} with github.get_issue. `
                + `Do what it asks with github.commit_files on branch "${branch}" from base "${defaultBranch}". `
                + `When I approve the commit, open a pull request with github.create_pull_request, head "${branch}", base "${defaultBranch}", `
                + `title "D14 walk ${stamp} (hosted)", body "Closes #${manifest.issue}."`,
            },
          });
          expect(m.status === 200, `mention ${m.status}: ${JSON.stringify(m.data)}`);
          const card = await waitForCard(podId, { tool: 'github.commit_files', agentName });
          const head = card.toolCall?.summary?.head;
          if (head !== branch) {
            // Never approve a write the walk did not ask for: it would land on a
            // branch cleanup does not know about. Decline it and fail the step.
            await decide(card.approvalId, 'declined');
            throw new Error(`parked head ${head}, expected ${branch}; declined`);
          }
          expect(!(await branchExists(branch)), 'the branch exists on GitHub before approval');
          // Only a card that passed every check reaches the approving step.
          commitCard = card;
          return `approval ${card.approvalId}`;
        });
        if (commitCard) {
          await step('hosted: approved commit lands, pull request parks, opens after approval', async () => {
            await decide(commitCard.approvalId, 'approved');
            manifest.branches.push(branch);
            const prCard = await waitForCard(podId, { tool: 'github.create_pull_request', head: branch });
            await noPr(branch, 'while parked');
            expect(prCard.toolCall?.summary?.base === defaultBranch, `PR base ${prCard.toolCall?.summary?.base}`);
            await decide(prCard.approvalId, 'approved');
            const pull = await waitForPull(branch);
            manifest.pulls.push(pull.number);
            expect(pull.head.ref.startsWith(`seat/${hostedId}/`), `PR head ${pull.head.ref} is not a seat/${hostedId}/ head`);
            return `#${pull.number} ${pull.head.ref}`;
          });
          await step('hosted: the agent claimed the task', async () => {
            const r = await api('GET', `/api/v1/tasks/${podId}`, { token: ownerToken });
            expect(r.status === 200, `tasks ${r.status}`);
            const task = (r.data.tasks || r.data || []).find((t) => String(t.taskId || t._id) === taskId);
            expect(task, 'task not found');
            expect(task.claimedByUserId === hostedId, `task claimed by ${task.claimedByUserId || 'nobody'}, not the agent`);
          });
        }
      }
    }
  } finally {
    // ---- Cleanup on every outcome --------------------------------------------
    const left = [];
    for (const g of manifest.grants) {
      const r = await api('DELETE', `/api/grants/${g}`, { token: ownerToken }); // eslint-disable-line no-await-in-loop
      // A 404 means the revoke matched nothing, so the grant may still be live.
      if (r.status >= 300) left.push(`grant ${g} (${r.status})`);
    }
    if (repo) {
      for (const n of manifest.pulls) {
        const r = await gh('PATCH', `/repos/${repo.owner}/${repo.repo}/pulls/${n}`, { state: 'closed' }); // eslint-disable-line no-await-in-loop
        if (r.status !== 200) left.push(`PR #${n} (${r.status})`);
      }
      for (const b of manifest.branches) {
        const r = await gh('DELETE', `/repos/${repo.owner}/${repo.repo}/git/refs/heads/${b}`); // eslint-disable-line no-await-in-loop
        if (r.status !== 204 && r.status !== 422) left.push(`branch ${b} (${r.status})`);
      }
      if (manifest.issue) {
        const r = await gh('PATCH', `/repos/${repo.owner}/${repo.repo}/issues/${manifest.issue}`, { state: 'closed' });
        if (r.status !== 200) left.push(`issue #${manifest.issue} (${r.status})`);
      }
    }
    for (const a of manifest.agents) {
      if (a.kind === 'hosted') await api('POST', '/api/hosted/deprovision', { token: ownerToken, body: { agentName: a.agentName } }); // eslint-disable-line no-await-in-loop
      const r = await api('DELETE', `/api/registry/agents/${encodeURIComponent(a.agentName)}/pods/${a.podId}?instanceId=default`, { token: ownerToken }); // eslint-disable-line no-await-in-loop
      if (r.status >= 300 && r.status !== 404) left.push(`agent ${a.agentName} (${r.status})`);
    }
    // Board tasks have no delete route; they go with their pod.
    for (const podId of manifest.pods) {
      const r = await api('DELETE', `/api/pods/${podId}`, { token: ownerToken }); // eslint-disable-line no-await-in-loop
      if (r.status >= 300 && r.status !== 404) left.push(`pod ${podId} (${r.status})`);
    }
    steps.push({ name: 'cleanup', ok: left.length === 0, ...(left.length ? { error: `left behind: ${left.join(', ')}` } : {}) });
    log(`${left.length ? 'FAIL' : 'PASS'} cleanup${left.length ? ` - left behind: ${left.join(', ')}` : ''}`);
    writeState();
  }
  const ok = steps.length > 1 && steps.every((s) => s.ok);
  return { exitCode: ok ? 0 : 1, steps, manifest };
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  runD14Walk(args).then(({ exitCode }) => process.exit(exitCode)).catch((error) => {
    console.error(`FAIL ${error.message}`);
    process.exit(1);
  });
}
