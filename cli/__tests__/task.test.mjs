/**
 * `commonly task` against a fake API. The routes are the ones the commonly_* task
 * tools call, and every fake body is the shape backend/routes/tasksApi.ts sends,
 * error text included, so a failure here means the CLI and the server disagree.
 */
import { Command } from 'commander';
import {
  registerTask,
  runTaskClaim,
  runTaskClose,
  runTaskCreate,
  runTaskList,
  runTaskUpdate,
} from '../src/commands/task.js';
import { TaskRefusal, checkTaskId, checkUpdateStatus, resolveTaskToken } from '../src/lib/task.js';

const POD = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ENV = { COMMONLY_AGENT_TOKEN: 'cm_agent_test', COMMONLY_API_URL: 'https://api.example.test' };

// `handler(method, path, body)` answers each request with { status, json }. Every request is recorded.
const fakeApi = (handler = () => ({ json: {} })) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const { pathname, search } = new URL(url);
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ method: init.method, path: pathname, search, body, auth: init.headers.Authorization });
    const { status = 200, json = {} } = handler(init.method, pathname, body) || {};
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(json) };
  };
  return { fetchImpl, calls };
};

const sink = () => {
  const lines = [];
  const errors = [];
  return { lines, errors, log: (line) => lines.push(line), error: (line) => errors.push(line) };
};

const depsFor = (fetchImpl, out) => ({ env: ENV, fetchImpl, log: out.log, error: out.error });

const row = (over = {}) => ({
  taskId: 'TASK-669', title: 'D214 gap', status: 'pending', priority: 'P1', assignee: 'wren', claimedByMe: false, ...over,
});

describe('task ids and status words', () => {
  test.each(['TASK-669', 'task-669', '669'])('%s names TASK-669', (input) => {
    expect(checkTaskId(input)).toBe('TASK-669');
  });

  test('anything else is refused before a request', () => {
    expect(() => checkTaskId('TASK-')).toThrow(TaskRefusal);
    expect(() => checkTaskId('wren/669')).toThrow(TaskRefusal);
  });

  test('update takes only pending or blocked; claim and close have their own verbs', () => {
    expect(checkUpdateStatus('Blocked')).toBe('blocked');
    expect(checkUpdateStatus('pending')).toBe('pending');
    expect(() => checkUpdateStatus('claimed')).toThrow(/commonly task claim/);
    expect(() => checkUpdateStatus('done')).toThrow(/commonly task close/);
  });
});

describe('identity', () => {
  test('the token comes from the agent env var, and the saved login is never read', () => {
    expect(resolveTaskToken({}, ENV)).toBe('cm_agent_test');
    expect(() => resolveTaskToken({}, { COMMONLY_TOKEN: 'operator-login' })).toThrow(/no token/);
  });
});

describe('list', () => {
  test('reads the board with the status filter and prints one line per row', async () => {
    const api = fakeApi(() => ({
      json: { tasks: [row(), row({ taskId: 'TASK-670', status: 'claimed', claimedByMe: true })] },
    }));
    const out = sink();
    const code = await runTaskList({ pod: POD, status: 'pending,claimed' }, depsFor(api.fetchImpl, out));

    expect(code).toBe(0);
    expect(api.calls[0]).toMatchObject({ method: 'GET', path: `/api/v1/tasks/${POD}`, auth: 'Bearer cm_agent_test' });
    expect(api.calls[0].search).toBe('?status=pending%2Cclaimed');
    expect(out.lines).toHaveLength(2);
    expect(out.lines[0]).toBe('TASK-669  pending  P1  wren  D214 gap');
  });

  test('--mine keeps only the rows this identity holds', async () => {
    const api = fakeApi(() => ({
      json: { tasks: [row(), row({ taskId: 'TASK-670', status: 'claimed', claimedByMe: true })] },
    }));
    const out = sink();
    await runTaskList({ pod: POD, mine: true }, depsFor(api.fetchImpl, out));

    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toMatch(/^TASK-670  claimed/);
  });

  test('--json prints the rows as JSON for agents', async () => {
    const api = fakeApi(() => ({ json: { tasks: [row()] } }));
    const out = sink();
    await runTaskList({ pod: POD, json: true }, depsFor(api.fetchImpl, out));

    expect(JSON.parse(out.lines[0])).toEqual([row()]);
  });
});

describe('create', () => {
  test('creates the row, then sets its notes in a second request', async () => {
    const api = fakeApi((method) => (method === 'POST'
      ? { status: 201, json: { task: row({ taskId: 'TASK-690' }) } }
      : { json: { task: row({ taskId: 'TASK-690', notes: 'Repro in staging' }) } }));
    const out = sink();
    const code = await runTaskCreate(
      { pod: POD, title: 'Fix the board', priority: 'p1', notes: 'Repro in staging' },
      depsFor(api.fetchImpl, out),
    );

    expect(code).toBe(0);
    expect(api.calls.map((c) => [c.method, c.path])).toEqual([
      ['POST', `/api/v1/tasks/${POD}`],
      ['PATCH', `/api/v1/tasks/${POD}/TASK-690`],
    ]);
    expect(api.calls[0].body).toEqual({ title: 'Fix the board', priority: 'P1' });
    expect(api.calls[1].body).toEqual({ notes: 'Repro in staging' });
  });

  test('without --notes it is one request', async () => {
    const api = fakeApi(() => ({ status: 201, json: { task: row({ taskId: 'TASK-691' }) } }));
    const out = sink();
    await runTaskCreate({ pod: POD, title: 'Plain row' }, depsFor(api.fetchImpl, out));

    expect(api.calls).toHaveLength(1);
    expect(api.calls[0].body).toEqual({ title: 'Plain row' });
  });

  test('a failed notes write says the row exists, so nobody retries the create into a twin', async () => {
    const api = fakeApi((method) => (method === 'POST'
      ? { status: 201, json: { task: row({ taskId: 'TASK-692' }) } }
      : { status: 500, json: { error: 'database unavailable' } }));
    const out = sink();
    const code = await runTaskCreate({ pod: POD, title: 'x', notes: 'n' }, depsFor(api.fetchImpl, out));

    expect(code).toBe(1);
    expect(out.errors).toEqual([
      'Created TASK-692, but --notes did not save. Failed (HTTP 500): database unavailable',
    ]);
  });
});

describe('claim', () => {
  test('takes the lease with a POST to /claim', async () => {
    const api = fakeApi(() => ({ json: { task: row({ status: 'claimed', claimedByMe: true }) } }));
    const out = sink();
    const code = await runTaskClaim('669', { pod: POD }, depsFor(api.fetchImpl, out));

    expect(code).toBe(0);
    expect(api.calls[0]).toMatchObject({ method: 'POST', path: `/api/v1/tasks/${POD}/TASK-669/claim`, body: {} });
  });

  test('--continue-anyway is sent as the body flag the route reads', async () => {
    const api = fakeApi(() => ({ json: { task: row({ status: 'claimed' }) } }));
    await runTaskClaim('TASK-669', { pod: POD, continueAnyway: true }, depsFor(api.fetchImpl, sink()));

    expect(api.calls[0].body).toEqual({ continueAnyway: true });
  });

  test('a live lease held by someone else is one plain line naming the holder and the time', async () => {
    // The claim route's compare-and-set loss answers with this text (tasksApi.ts, "Task already claimed").
    const api = fakeApi(() => ({
      status: 409,
      json: {
        error: 'Task already claimed',
        claimedBy: 'alpha',
        status: 'claimed',
        claimExpiresAt: '2026-10-31T22:04:00.000Z',
      },
    }));
    const out = sink();
    const code = await runTaskClaim('669', { pod: POD }, depsFor(api.fetchImpl, out));

    expect(code).toBe(1);
    expect(out.errors).toEqual([
      'Failed (HTTP 409): Task already claimed (held by alpha, lease until 22:04Z)',
    ]);
  });

  test('an unseen-messages hold is named by its count, with the way out', async () => {
    // The hold carries code 'unseen_messages' (agentSendFreshness.ts), which is the branch the CLI takes.
    const api = fakeApi(() => ({
      status: 409,
      json: { code: 'unseen_messages', unseenCount: 3, message: 'There are 3 unseen messages.', messages: [] },
    }));
    const out = sink();
    const code = await runTaskClaim('669', { pod: POD }, depsFor(api.fetchImpl, out));

    expect(code).toBe(1);
    expect(out.errors).toEqual([
      'Failed (HTTP 409): 3 unseen messages in this pod. Read them and retry, or pass --continue-anyway to go ahead.',
    ]);
  });
});

describe('update', () => {
  test('a status change is a PATCH of that field only', async () => {
    const api = fakeApi(() => ({ json: { task: row({ status: 'blocked' }) } }));
    const out = sink();
    const code = await runTaskUpdate('669', { pod: POD, status: 'blocked' }, depsFor(api.fetchImpl, out));

    expect(code).toBe(0);
    expect(api.calls[0]).toMatchObject({ method: 'PATCH', path: `/api/v1/tasks/${POD}/TASK-669`, body: { status: 'blocked' } });
  });

  test('an empty --assignee is sent as an empty string, which the server stores as unassigned', async () => {
    const api = fakeApi(() => ({ json: { task: row({ assignee: null }) } }));
    await runTaskUpdate('669', { pod: POD, assignee: '' }, depsFor(api.fetchImpl, sink()));

    expect(api.calls[0].body).toEqual({ assignee: '' });
  });

  test('--note is a POST to the updates route', async () => {
    const api = fakeApi(() => ({ status: 201, json: { task: row() } }));
    await runTaskUpdate('669', { pod: POD, note: 'PR is up' }, depsFor(api.fetchImpl, sink()));

    expect(api.calls[0]).toMatchObject({ method: 'POST', path: `/api/v1/tasks/${POD}/TASK-669/updates`, body: { text: 'PR is up' } });
  });

  test('claiming through update is refused before any request', async () => {
    const api = fakeApi();
    const out = sink();
    const code = await runTaskUpdate('669', { pod: POD, status: 'claimed' }, depsFor(api.fetchImpl, out));

    expect(code).toBe(1);
    expect(api.calls).toEqual([]);
    expect(out.errors[0]).toMatch(/^refusing: --status claimed is refused/);
  });

  test('nothing to change is refused before any request', async () => {
    const api = fakeApi();
    const out = sink();
    const code = await runTaskUpdate('669', { pod: POD }, depsFor(api.fetchImpl, out));

    expect(code).toBe(1);
    expect(api.calls).toEqual([]);
    expect(out.errors[0]).toMatch(/^refusing: nothing to change/);
  });

  test('a failed note after a field change says the field did save', async () => {
    const api = fakeApi((method) => (method === 'PATCH'
      ? { json: { task: row({ title: 'Renamed' }) } }
      : { status: 500, json: { error: 'database unavailable' } }));
    const out = sink();
    const code = await runTaskUpdate(
      '669',
      { pod: POD, title: 'Renamed', note: 'context' },
      depsFor(api.fetchImpl, out),
    );

    expect(code).toBe(1);
    expect(out.errors).toEqual([
      'Updated TASK-669, but --note did not post. Failed (HTTP 500): database unavailable',
    ]);
  });
});

describe('close', () => {
  test('completes the row with the PR when one is given', async () => {
    const api = fakeApi(() => ({ json: { task: row({ status: 'done' }) } }));
    const out = sink();
    const pr = 'https://github.com/Team-Commonly/commonly/pull/3089';
    const code = await runTaskClose('669', { pod: POD, pr }, depsFor(api.fetchImpl, out));

    expect(code).toBe(0);
    expect(api.calls[0]).toMatchObject({ method: 'POST', path: `/api/v1/tasks/${POD}/TASK-669/complete`, body: { prUrl: pr } });
    expect(out.lines[0]).toBe('TASK-669  done  P1  wren  D214 gap');
  });

  test('a seat that is neither creator nor holder gets the 409 as one plain line', async () => {
    // Complete answers with the lease helper's refusal (tasksApi.ts, leaseRefusalForWrite).
    const api = fakeApi(() => ({
      status: 409,
      json: {
        error: 'Task is claimed by another seat',
        status: 'claimed',
        claimedBy: 'alpha',
        claimExpiresAt: '2026-10-31T22:04:00.000Z',
      },
    }));
    const out = sink();
    const code = await runTaskClose('669', { pod: POD }, depsFor(api.fetchImpl, out));

    expect(code).toBe(1);
    expect(out.errors).toEqual([
      'Failed (HTTP 409): Task is claimed by another seat (held by alpha, lease until 22:04Z)',
    ]);
  });

  test('a non-member gets one plain 403 line', async () => {
    // requirePodMember's write gate answers a non-member with this text (podMembershipService.ts).
    const api = fakeApi(() => ({ status: 403, json: { error: 'Write access denied' } }));
    const out = sink();
    const code = await runTaskClose('669', { pod: POD }, depsFor(api.fetchImpl, out));

    expect(code).toBe(1);
    expect(out.errors).toEqual(['Failed (HTTP 403): Write access denied']);
    expect(out.errors[0]).not.toContain('\n');
  });
});

describe('registration', () => {
  test('wires the five subcommands, each with a required --pod', () => {
    const program = new Command();
    program.exitOverride();
    registerTask(program);
    const task = program.commands.find((c) => c.name() === 'task');

    expect(task.commands.map((c) => c.name())).toEqual(['list', 'create', 'claim', 'update', 'close']);
    for (const sub of task.commands) {
      expect(sub.options.some((o) => o.long === '--pod' && o.mandatory)).toBe(true);
    }
  });
});
