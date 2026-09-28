/**
 * `commonly inbox` — one account's own attention queue.
 *
 * The identity rule is the reason this command exists, so it is what most of
 * this file tests: with no token file it refuses BEFORE it makes a request, and
 * with one it sends THAT token even when a saved login and COMMONLY_TOKEN are
 * both present and both belong to somebody else. `fetchImpl` is injected so
 * "no request" is observable rather than inferred from a message.
 */

import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { Command } from 'commander';

const homeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-inbox-home-'));
await jest.unstable_mockModule('os', () => ({
  ...os,
  default: { ...os, homedir: () => homeTmpDir },
  homedir: () => homeTmpDir,
}));

const { saveInstance } = await import('../src/lib/config.js');
const {
  runInboxList, runInboxAck, runInboxChoose, registerInbox,
} = await import('../src/commands/inbox.js');
const {
  extractToken, filterItems, nextCursorFrom, parseCursor, formatCursor,
  formatItemLine, createScrubber, retryDelayMs, DEFAULT_BACKOFF_MS, MAX_BACKOFF_MS,
} = await import('../src/lib/inbox.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-inbox-'));
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(homeTmpDir, { recursive: true, force: true });
});

const writeTokenFile = (name, body) => {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, body);
  return file;
};

const hex = (n) => n.toString(16).padStart(24, '0');
const item = (n, over = {}) => ({
  id: hex(100 + n),
  attentionItemId: hex(200 + n),
  kind: 'mention',
  sourceType: 'post',
  title: `item ${n}`,
  podId: hex(7),
  podName: 'Sharpen',
  createdAt: new Date(Date.UTC(2026, 8, 28, 3, n)).toISOString(),
  ...over,
});

const jsonRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});

const stubFetch = (routes) => {
  const calls = [];
  const fn = jest.fn(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [needle, response] of Object.entries(routes)) {
      if (String(url).includes(needle)) {
        return typeof response === 'function' ? response(String(url), init) : response;
      }
    }
    throw new Error(`unexpected request: ${url}`);
  });
  fn.calls = calls;
  return fn;
};

const capture = () => {
  const out = [];
  const err = [];
  return {
    out,
    err,
    log: (line) => out.push(String(line)),
    error: (line) => err.push(String(line)),
    // Injected so a 429 backoff cannot make the suite wait on wall-clock time.
    sleep: jest.fn(async () => {}),
  };
};

const USER = { _id: hex(1), username: 'connector-ops' };
const queuePage = (items, extra = {}) => jsonRes({
  items, count: items.length, countsByKind: { mention: items.length }, hasMore: false, ...extra,
});
const routesFor = (page, over = {}) => ({
  '/api/auth/user': jsonRes(USER),
  '/api/activity/decision-queue': page,
  ...over,
});

const runList = async (opts, routes) => {
  const fetchImpl = stubFetch(routes);
  const io = capture();
  const code = await runInboxList(opts, { fetchImpl, env: {}, ...io });
  return { code, fetchImpl, ...io };
};

describe('identity: the account comes from the token file or nowhere', () => {
  test('no --token-file and no env variable refuses before any request', async () => {
    const { code, fetchImpl, err } = await runList({}, routesFor(queuePage([])));
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('refusing: no token file');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('an empty COMMONLY_TOKEN_FILE does not count as a token file', async () => {
    const fetchImpl = stubFetch(routesFor(queuePage([])));
    const io = capture();
    const code = await runInboxList({}, { fetchImpl, env: { COMMONLY_TOKEN_FILE: '  ' }, ...io });
    expect(code).toBe(1);
    expect(io.err.join('\n')).toContain('refusing: no token file');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('an unreadable token file refuses and names the path', async () => {
    const missing = path.join(tmpDir, 'nope-token');
    const { code, fetchImpl, err } = await runList({ tokenFile: missing }, routesFor(queuePage([])));
    expect(code).toBe(1);
    expect(err.join('\n')).toContain(`Cannot read the token file ${missing}`);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('an empty token file refuses', async () => {
    const file = writeTokenFile('empty-token', '\n\n');
    const { code, fetchImpl, err } = await runList({ tokenFile: file }, routesFor(queuePage([])));
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('No token in');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('a JSON token file with no recognised field refuses', async () => {
    const file = writeTokenFile('nofield-token.json', JSON.stringify({ environment: { mcp: [] } }));
    const { code, fetchImpl, err } = await runList({ tokenFile: file }, routesFor(queuePage([])));
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('No token in');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('an agent runtime token is refused by name, before any request', async () => {
    const file = writeTokenFile('agent-token', 'cm_agent_abcdef\n');
    const { code, fetchImpl, err } = await runList({ tokenFile: file }, routesFor(queuePage([])));
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('AGENT runtime token');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('the file token is sent, not the saved login and not COMMONLY_TOKEN', async () => {
    // The saved login on a shared host belongs to somebody else. Both fallbacks
    // exist elsewhere in the CLI; this command must ignore both.
    saveInstance({
      key: 'default', url: 'https://api.commonly.me', token: 'sam-saved-token', userId: 'sam', username: 'sam',
    });
    const file = writeTokenFile('ops-token', 'connector-ops-token\n');
    const fetchImpl = stubFetch(routesFor(queuePage([item(1)])));
    const io = capture();
    const code = await runInboxList({ tokenFile: file }, {
      fetchImpl, env: { COMMONLY_TOKEN: 'sam-env-token' }, ...io,
    });

    expect(code).toBe(0);
    expect(fetchImpl.calls.length).toBeGreaterThan(0);
    for (const call of fetchImpl.calls) {
      expect(call.init.headers.Authorization).toBe('Bearer connector-ops-token');
    }
    expect(fetchImpl.calls[0].url).toBe('https://api.commonly.me/api/auth/user');
  });

  test('COMMONLY_TOKEN_FILE is read when the flag is absent', async () => {
    const file = writeTokenFile('lily-token', 'lily-token-value\n');
    const fetchImpl = stubFetch(routesFor(queuePage([])));
    const io = capture();
    const code = await runInboxList({}, { fetchImpl, env: { COMMONLY_TOKEN_FILE: file }, ...io });
    expect(code).toBe(0);
    expect(fetchImpl.calls[0].init.headers.Authorization).toBe('Bearer lily-token-value');
    expect(io.out[0]).toBe('account: connector-ops @ https://api.commonly.me');
  });

  test('--token-file wins over COMMONLY_TOKEN_FILE', async () => {
    // Two accounts, two files: the flag must be the one that decides, or an
    // operator who sets the env var for a watcher would silently read the
    // wrong queue from an interactive shell.
    const flagged = writeTokenFile('flagged-token', 'flagged-value\n');
    const envFile = writeTokenFile('env-token', 'env-value\n');
    const fetchImpl = stubFetch(routesFor(queuePage([])));
    const io = capture();
    const code = await runInboxList({ tokenFile: flagged }, {
      fetchImpl, env: { COMMONLY_TOKEN_FILE: envFile }, ...io,
    });
    expect(code).toBe(0);
    expect(fetchImpl.calls[0].init.headers.Authorization).toBe('Bearer flagged-value');
  });

  test('the first line names whose queue was read', async () => {
    const file = writeTokenFile('named-token', 'tok\n');
    const { code, out } = await runList({ tokenFile: file }, routesFor(queuePage([])));
    expect(code).toBe(0);
    expect(out[0]).toBe('account: connector-ops @ https://api.commonly.me');
  });

  test('a 401 names the token FILE and never suggests `commonly login`', async () => {
    const file = writeTokenFile('stale-token', 'stale-secret-value\n');
    const { code, err } = await runList({ tokenFile: file }, {
      '/api/auth/user': jsonRes({ error: 'Token is not valid: stale-secret-value' }, 401),
    });
    const text = err.join('\n');
    expect(code).toBe(1);
    expect(text).toContain(file);
    expect(text).not.toContain('stale-secret-value');
    expect(text).toContain('[redacted]');
    expect(text).not.toContain('commonly login');
  });

  test('a 429 is backed off on Retry-After and the read continues', async () => {
    // Live finding while verifying this command: /api/activity is limited to 60
    // requests a minute KEYED ON THE CALLER IP, so a run that pages a large
    // queue shares the bucket with every session on the host and with the
    // operator's browser. A 429 is therefore an ordinary busy signal.
    const file = writeTokenFile('backoff-token', 'backoff-secret-value\n');
    let calls = 0;
    const fetchImpl = stubFetch({
      '/api/auth/user': () => {
        calls += 1;
        return calls === 1
          ? {
            ok: false,
            status: 429,
            headers: { get: () => '2' },
            text: async () => JSON.stringify({ code: 'rate_limited' }),
          }
          : jsonRes(USER);
      },
      '/api/activity/decision-queue': queuePage([item(1)]),
    });
    const io = capture();
    const code = await runInboxList({ tokenFile: file }, { fetchImpl, env: {}, ...io });
    expect(code).toBe(0);
    expect(io.sleep).toHaveBeenCalledWith(2000);
    expect(io.out[0]).toBe('account: connector-ops @ https://api.commonly.me');
  });

  test('a persistent 429 names the IP-keyed limiter after the retries are spent', async () => {
    const file = writeTokenFile('limited-token', 'limited-secret-value\n');
    const fetchImpl = stubFetch({ '/api/auth/user': jsonRes({ code: 'rate_limited' }, 429) });
    const io = capture();
    const code = await runInboxList({ tokenFile: file }, { fetchImpl, env: {}, ...io });

    expect(code).toBe(1);
    expect(fetchImpl.mock.calls.length).toBe(3); // the first call plus two retries
    expect(io.sleep).toHaveBeenCalledTimes(2);
    expect(io.sleep).toHaveBeenCalledWith(DEFAULT_BACKOFF_MS);
    // The server's own field is `code`; without it the operator sees `HTTP 429`
    // and cannot tell a busy instance from a dead token.
    expect(io.err.join('\n')).toContain('rate_limited');
    expect(io.err.join('\n')).toContain('keyed on the caller IP');
    expect(io.err.join('\n')).not.toContain('limited-secret-value');
  });

  test('Retry-After is honoured, capped, and falls back when absent or unparseable', () => {
    expect(retryDelayMs({ headers: { get: () => '2' } })).toBe(2000);
    expect(retryDelayMs({ headers: { get: () => '600' } })).toBe(MAX_BACKOFF_MS);
    expect(retryDelayMs({ headers: { get: () => 'nonsense' } })).toBe(DEFAULT_BACKOFF_MS);
    expect(retryDelayMs({})).toBe(DEFAULT_BACKOFF_MS);
  });

  test.each([
    ['raw', 'plain-token'],
    ['bearer-prefixed', 'Bearer plain-token'],
    ['json token', JSON.stringify({ token: 'plain-token' })],
    ['json runtimeToken', JSON.stringify({ runtimeToken: 'plain-token' })],
  ])('extractToken accepts a %s file', (_label, body) => {
    expect(extractToken(body)).toBe('plain-token');
  });

  test('extractToken returns null for a JSON body it does not recognise', () => {
    expect(extractToken('{')).toBeNull();
    expect(extractToken('   ')).toBeNull();
  });
});

describe('list: paging, filter, cursor', () => {
  test('follows hasMore and advances offset by the page it received', async () => {
    const first = Array.from({ length: 50 }, (_, i) => item(i + 1));
    const second = [item(51), item(52)];
    const page = (url) => {
      const offset = Number(new URL(url).searchParams.get('offset'));
      return offset === 0
        ? jsonRes({ items: first, count: 52, hasMore: true, countsByKind: { mention: 52 } })
        : jsonRes({ items: second, count: 52, hasMore: false, countsByKind: { mention: 52 } });
    };
    const { code, fetchImpl, out } = await runList({ tokenFile: writeTokenFile('page-token', 't\n') }, routesFor(page));
    expect(code).toBe(0);
    const offsets = fetchImpl.calls
      .filter((call) => call.url.includes('decision-queue'))
      .map((call) => new URL(call.url).searchParams.get('offset'));
    expect(offsets).toEqual(['0', '50']);
    expect(out.filter((line) => line.startsWith('mention'))).toHaveLength(52);
  });

  test('a short page advances the offset by what it received, not by the page cap', async () => {
    // A server that returns 1 item with hasMore (its own filter narrowed the
    // page) must not push the next offset to 50: the 49 rows between would
    // never be read.
    const file = writeTokenFile('shortpage-token', 't\n');
    const page = (url) => {
      const offset = Number(new URL(url).searchParams.get('offset'));
      return offset === 0
        ? jsonRes({
          items: [item(1)], count: 3, hasMore: true, countsByKind: { mention: 3 },
        })
        : jsonRes({
          items: [item(2), item(3)], count: 3, hasMore: false, countsByKind: { mention: 3 },
        });
    };
    const { code, fetchImpl, out } = await runList({ tokenFile: file }, routesFor(page));
    expect(code).toBe(0);
    const offsets = fetchImpl.calls
      .filter((call) => call.url.includes('decision-queue'))
      .map((call) => new URL(call.url).searchParams.get('offset'));
    expect(offsets).toEqual(['0', '1']);
    expect(out.filter((line) => line.startsWith('mention'))).toHaveLength(3);
  });

  test('stops when a page claims hasMore but carries no items', async () => {
    const file = writeTokenFile('loop-token', 't\n');
    const empty = jsonRes({ items: [], count: 99, hasMore: true, countsByKind: {} });
    const { code, fetchImpl } = await runList({ tokenFile: file }, routesFor(empty));
    expect(code).toBe(0);
    const queueCalls = fetchImpl.calls.filter((call) => call.url.includes('decision-queue'));
    expect(queueCalls).toHaveLength(1);
  });

  test('stops once the server-reported count is reached', async () => {
    // The second page exists and would be fetched if the count guard were gone,
    // so this arm fails cleanly instead of spinning — a mutation that hangs is
    // not a mutation that is killed.
    const file = writeTokenFile('count-token', 't\n');
    let call = 0;
    const page = () => {
      call += 1;
      return call === 1
        ? jsonRes({
          items: [item(1), item(2)], count: 2, hasMore: true, countsByKind: { mention: 2 },
        })
        : jsonRes({
          items: [item(3)], count: 3, hasMore: false, countsByKind: { mention: 3 },
        });
    };
    const { code, fetchImpl } = await runList({ tokenFile: file }, routesFor(page));
    expect(code).toBe(0);
    expect(fetchImpl.calls.filter((call2) => call2.url.includes('decision-queue'))).toHaveLength(1);
  });

  test('--kind prints only that kind and an unknown kind refuses without a request', async () => {
    const file = writeTokenFile('kind-token', 't\n');
    const page = queuePage([
      item(1, { kind: 'mention' }),
      item(2, { kind: 'decision', id: hex(900), title: 'pick a store' }),
      item(3, { kind: 'handoff' }),
    ]);
    const filtered = await runList({ tokenFile: file, kind: 'decision' }, routesFor(page));
    expect(filtered.code).toBe(0);
    expect(filtered.out.filter((line) => /^(mention|decision|handoff)\s/.test(line))).toHaveLength(1);
    expect(filtered.out.some((line) => line.includes('pick a store'))).toBe(true);

    const bad = await runList({ tokenFile: file, kind: 'urgent' }, routesFor(page));
    expect(bad.code).toBe(1);
    expect(bad.err.join('\n')).toContain('Unknown --kind urgent');
    expect(bad.fetchImpl).not.toHaveBeenCalled();
  });

  test('a cursor written by a kind-filtered read refuses a read with a different filter', async () => {
    const file = writeTokenFile('kind-cursor-token', 't\n');
    const cursorFile = path.join(tmpDir, 'kindfilter-mention.cursor');
    const page = queuePage([
      item(1, { kind: 'mention' }),
      item(2, {
        kind: 'decision',
        id: hex(900),
        title: 'pick a store',
        createdAt: new Date(Date.UTC(2026, 8, 28, 3, 0)).toISOString(),
      }),
    ]);
    // The read that owns the cursor: allowed, and the file records its filter.
    const mention = await runList({ tokenFile: file, kind: 'mention', cursorFile }, routesFor(page));
    expect(mention.code).toBe(0);
    expect(fs.readFileSync(cursorFile, 'utf8')).toContain('"kind":"mention"');

    // The same file, read without the filter. The decision above is OLDER than
    // the mention read advanced to, so this read would never print it — and no
    // later read could either. Refused before any request.
    const broad = await runList({ tokenFile: file, cursorFile }, routesFor(page));
    expect(broad.code).toBe(1);
    expect(broad.err.join('\n')).toContain('written by a read with --kind mention');
    expect(broad.err.join('\n')).toContain('not filtered by kind');
    expect(broad.fetchImpl).not.toHaveBeenCalled();

    // A different filter is the same defect from the other side.
    const other = await runList({ tokenFile: file, kind: 'decision', cursorFile }, routesFor(page));
    expect(other.code).toBe(1);
    expect(other.err.join('\n')).toContain('written by a read with --kind mention');
    expect(other.fetchImpl).not.toHaveBeenCalled();
  });

  test('a broad cursor read by a filtered read is allowed: that earlier read printed every kind', async () => {
    const file = writeTokenFile('broad-cursor-token', 't\n');
    const cursorFile = path.join(tmpDir, 'broad.cursor');
    const page = queuePage([item(1, { kind: 'mention' }), item(2, { kind: 'decision', id: hex(900) })]);
    const broad = await runList({ tokenFile: file, cursorFile }, routesFor(page));
    expect(broad.code).toBe(0);
    expect(fs.readFileSync(cursorFile, 'utf8')).not.toContain('"kind"');

    const narrowed = await runList({ tokenFile: file, kind: 'mention', cursorFile }, routesFor(page));
    expect(narrowed.code).toBe(0);
    expect(narrowed.fetchImpl).toHaveBeenCalled();
  });

  // NOT a fix-witness — this shape already worked before the refusal. It asserts
  // that the remedy the refusal names is real: with one cursor file per kind,
  // a mention read advances only the mention cursor, so a decision that is
  // OLDER than it is still printed by the decision read. (With one shared file
  // that decision is behind the high-water mark forever, which is the loss the
  // refusal exists to prevent.)
  test('one cursor file per kind: an older item of another kind is still printed', async () => {
    const file = writeTokenFile('per-kind-token', 't\n');
    const page = queuePage([
      item(1, { kind: 'mention' }),
      item(2, {
        kind: 'decision',
        id: hex(900),
        title: 'pick a store',
        createdAt: new Date(Date.UTC(2026, 8, 28, 3, 0)).toISOString(),
      }),
    ]);
    const mention = await runList(
      { tokenFile: file, kind: 'mention', cursorFile: path.join(tmpDir, 'perkind-mention.cursor') },
      routesFor(page),
    );
    expect(mention.code).toBe(0);
    expect(mention.out.some((line) => line.includes('item 1'))).toBe(true);

    const decision = await runList(
      { tokenFile: file, kind: 'decision', cursorFile: path.join(tmpDir, 'perkind-decision.cursor') },
      routesFor(page),
    );
    expect(decision.code).toBe(0);
    expect(decision.out.some((line) => line.includes('pick a store'))).toBe(true);
  });

  test('--pod is passed through to the queue as a query parameter', async () => {
    const file = writeTokenFile('pod-token', 't\n');
    const { code, fetchImpl } = await runList({ tokenFile: file, pod: hex(7) }, routesFor(queuePage([])));
    expect(code).toBe(0);
    const queueUrl = fetchImpl.calls.find((call) => call.url.includes('decision-queue')).url;
    expect(new URL(queueUrl).searchParams.get('podId')).toBe(hex(7));
  });

  test('--since is inclusive of its own millisecond and the cursor lands on the newest printed', async () => {
    const file = writeTokenFile('since-token', 't\n');
    const page = queuePage([item(3), item(2), item(1)]);
    const { code, out } = await runList(
      { tokenFile: file, since: new Date(Date.UTC(2026, 8, 28, 3, 1)).toISOString() },
      routesFor(page),
    );
    expect(code).toBe(0);
    // 03:01 is the boundary: an item AT it prints (it may have been inserted after
    // that cursor was taken), so all three print and the run is not a way to lose a
    // row. Anything older still does not.
    expect(out.filter((line) => line.startsWith('mention'))).toHaveLength(3);
    expect(out).toContain(`cursor: ${new Date(Date.UTC(2026, 8, 28, 3, 3)).toISOString()}`);
    const older = await runList(
      { tokenFile: file, since: new Date(Date.UTC(2026, 8, 28, 3, 2)).toISOString() },
      routesFor(page),
    );
    expect(older.out.join('\n')).not.toContain('mention  item=' + hex(201));
  });

  test('nothing newer than the cursor leaves the cursor where it was', async () => {
    const file = writeTokenFile('quiet-token', 't\n');
    const since = new Date(Date.UTC(2026, 8, 28, 4, 0)).toISOString();
    const { code, out } = await runList({ tokenFile: file, since }, routesFor(queuePage([item(1)])));
    expect(code).toBe(0);
    expect(out.join('\n')).toContain(`(no items newer than ${since})`);
    expect(out).toContain(`cursor: ${since}`);
  });

  test('an item whose createdAt cannot be parsed is kept, not silently dropped', async () => {
    const file = writeTokenFile('badstamp-token', 't\n');
    const page = queuePage([item(1, { createdAt: 'not-a-date' })]);
    const { code, out } = await runList({ tokenFile: file, since: '2026-09-28T00:00:00.000Z' }, routesFor(page));
    expect(code).toBe(0);
    expect(out.filter((line) => line.startsWith('mention'))).toHaveLength(1);
  });

  test('a bad --since refuses by name', async () => {
    const file = writeTokenFile('bad-since-token', 't\n');
    const { code, err } = await runList({ tokenFile: file, since: 'yesterday' }, routesFor(queuePage([])));
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('Not an ISO-8601 timestamp: yesterday');
  });

  test('--cursor-file supplies the cursor and receives the advanced one', async () => {
    const file = writeTokenFile('cf-token', 't\n');
    const cursorFile = path.join(tmpDir, 'inbox.cursor');
    const page = queuePage([item(5), item(1)]);
    const first = await runList({ tokenFile: file, cursorFile }, routesFor(page));
    expect(first.code).toBe(0);
    expect(JSON.parse(fs.readFileSync(cursorFile, 'utf8').trim()))
      .toEqual({ at: new Date(Date.UTC(2026, 8, 28, 3, 5)).toISOString(), ids: [item(5).attentionItemId] });
    expect(first.out).not.toContain(`(no items newer than`);

    const second = await runList({ tokenFile: file, cursorFile }, routesFor(page));
    expect(second.code).toBe(0);
    expect(second.out.join('\n')).toContain('(no items newer than');
  });

  /**
   * The boundary defect, reproduced at the command level. X and Y share a
   * millisecond; Y is inserted after the cursor was written. With a bare
   * `ms > since` cursor Y is never printed by this run or any later one, because
   * the cursor cannot move past a millisecond it already passed.
   */
  test('an item inserted at the cursor\'s own millisecond is printed, not lost', async () => {
    const file = writeTokenFile('boundary-token', 't\n');
    const cursorFile = path.join(tmpDir, 'boundary.cursor');
    const x = item(1);
    const y = item(1, { attentionItemId: hex(999), id: hex(998), title: 'late sibling' });
    expect(y.createdAt).toBe(x.createdAt);

    const first = await runList({ tokenFile: file, cursorFile }, routesFor(queuePage([x])));
    expect(first.code).toBe(0);
    expect(first.out.filter((line) => line.startsWith('mention'))).toHaveLength(1);
    // The control: without the sibling present there is nothing to print, so the
    // run below cannot pass because the filter is off.
    const control = await runList({ tokenFile: file, cursorFile }, routesFor(queuePage([x])));
    expect(control.out.join('\n')).toContain('(no items newer than');

    const second = await runList({ tokenFile: file, cursorFile }, routesFor(queuePage([x, y])));
    expect(second.code).toBe(0);
    expect(second.out.join('\n')).toContain(`item=${y.attentionItemId}`);
    expect(second.out.join('\n')).not.toContain(`item=${x.attentionItemId}`);

    const third = await runList({ tokenFile: file, cursorFile }, routesFor(queuePage([x, y])));
    expect(third.out.join('\n')).toContain('(no items newer than');
  });

  test('a legacy plain-timestamp cursor re-prints the boundary item instead of dropping it', async () => {
    const file = writeTokenFile('legacy-token', 't\n');
    const cursorFile = path.join(tmpDir, 'legacy.cursor');
    const x = item(1);
    const y = item(1, { attentionItemId: hex(999), id: hex(998), title: 'late sibling' });
    // What an operator gets by copying the `cursor:` line, and what older
    // versions wrote: no id set, so the millisecond re-prints. Recoverable, which
    // is the direction this module always picks (see filterItems).
    fs.writeFileSync(cursorFile, `${x.createdAt}\n`);
    const { code, out } = await runList({ tokenFile: file, cursorFile }, routesFor(queuePage([x, y])));
    expect(code).toBe(0);
    expect(out.join('\n')).toContain(`item=${x.attentionItemId}`);
    expect(out.join('\n')).toContain(`item=${y.attentionItemId}`);
  });

  test('the cursor carries the ids at its own millisecond and drops them when it moves', async () => {
    const file = writeTokenFile('carry-token', 't\n');
    const cursorFile = path.join(tmpDir, 'carry.cursor');
    const x = item(1);
    const y = item(1, { attentionItemId: hex(999), id: hex(998), title: 'late sibling' });
    const z = item(9);
    const read = () => JSON.parse(fs.readFileSync(cursorFile, 'utf8').trim());

    await runList({ tokenFile: file, cursorFile }, routesFor(queuePage([x])));
    expect(read()).toEqual({ at: x.createdAt, ids: [x.attentionItemId] });

    await runList({ tokenFile: file, cursorFile }, routesFor(queuePage([x, y])));
    expect(read()).toEqual({ at: x.createdAt, ids: [x.attentionItemId, y.attentionItemId] });

    const moved = await runList({ tokenFile: file, cursorFile }, routesFor(queuePage([x, y, z])));
    expect(moved.out.join('\n')).toContain(`item=${z.attentionItemId}`);
    // Stale ids cannot match once the timestamp moves (the check needs
    // `ms === sinceMs`), so they are dropped rather than carried forever.
    expect(read()).toEqual({ at: z.createdAt, ids: [z.attentionItemId] });
  });

  test('an explicit --since wins over the cursor file', async () => {
    const file = writeTokenFile('precedence-token', 't\n');
    const cursorFile = path.join(tmpDir, 'precedence.cursor');
    const newer = new Date(Date.UTC(2026, 8, 28, 3, 9)).toISOString();
    fs.writeFileSync(cursorFile, '2026-09-28T03:00:00.000Z\n');
    const { code, out } = await runList({ tokenFile: file, cursorFile, since: newer }, routesFor(queuePage([item(1)])));
    expect(code).toBe(0);
    expect(out.join('\n')).toContain(`(no items newer than ${newer})`);
    expect(JSON.parse(fs.readFileSync(cursorFile, 'utf8').trim())).toEqual({ at: newer, ids: [] });
  });

  test('a missing cursor file is simply no cursor', async () => {
    const file = writeTokenFile('nocursor-token', 't\n');
    const { code, out } = await runList(
      { tokenFile: file, cursorFile: path.join(tmpDir, 'absent.cursor') },
      routesFor(queuePage([item(1)])),
    );
    expect(code).toBe(0);
    expect(out.filter((line) => line.startsWith('mention'))).toHaveLength(1);
  });


  test('--json emits one object carrying both ids, the account and the cursor', async () => {
    const file = writeTokenFile('json-token', 't\n');
    const page = queuePage([item(1, { kind: 'decision', title: 'pick a store' })]);
    const { code, out } = await runList({ tokenFile: file, json: true }, routesFor(page));
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0]);
    expect(parsed.account).toBe('connector-ops');
    expect(parsed.count).toBe(1);
    expect(parsed.cursor).toBe(item(1).createdAt);
    expect(parsed.countsByKind).toEqual({ mention: 1 });
    expect(parsed.items[0]).toMatchObject({
      id: item(1).id, attentionItemId: item(1).attentionItemId, kind: 'decision', title: 'pick a store',
    });
  });
});

describe('ack and choose', () => {
  test('ack posts the attentionItemId with the file token', async () => {
    const file = writeTokenFile('ack-token', 'ack-secret\n');
    const seen = [];
    const fetchImpl = stubFetch({
      '/api/auth/user': jsonRes(USER),
      '/acknowledge': (url, init) => {
        seen.push({ url, init });
        return jsonRes({ success: true });
      },
    });
    const io = capture();
    const code = await runInboxAck(hex(201), { tokenFile: file }, { fetchImpl, env: {}, ...io });

    expect(code).toBe(0);
    expect(io.out[0]).toBe('account: connector-ops @ https://api.commonly.me');
    expect(seen[0].url).toBe(`https://api.commonly.me/api/activity/${hex(201)}/acknowledge`);
    expect(seen[0].init.method).toBe('POST');
    expect(seen[0].init.headers.Authorization).toBe('Bearer ack-secret');
    expect(io.out.join('\n')).toContain(`acked ${hex(201)}`);
  });

  test('an ack the server refuses explains which of the two ids to pass', async () => {
    const file = writeTokenFile('ack400-token', 't\n');
    const fetchImpl = stubFetch({
      '/api/auth/user': jsonRes(USER),
      '/acknowledge': jsonRes({ error: 'Attention item not found' }, 400),
    });
    const io = capture();
    const code = await runInboxAck(hex(101), { tokenFile: file }, { fetchImpl, env: {}, ...io });

    expect(code).toBe(1);
    const text = io.err.join('\n');
    expect(text).toContain('Attention item not found');
    expect(text).toContain('attentionItemId');
    expect(text).toContain('item=');
  });

  test('choose posts the value to the decision route', async () => {
    const file = writeTokenFile('choose-token', 'choose-secret\n');
    const seen = [];
    const fetchImpl = stubFetch({
      '/api/auth/user': jsonRes(USER),
      '/choose': (url, init) => {
        seen.push({ url, init });
        return jsonRes({ status: 'ruled', body: { value: '2' } });
      },
    });
    const io = capture();
    const code = await runInboxChoose(hex(101), '2', { tokenFile: file }, { fetchImpl, env: {}, ...io });

    expect(code).toBe(0);
    expect(io.out[0]).toBe('account: connector-ops @ https://api.commonly.me');
    expect(seen[0].url).toBe(`https://api.commonly.me/api/activity/decisions/${hex(101)}/choose`);
    expect(JSON.parse(seen[0].init.body)).toEqual({ value: '2' });
    expect(io.out.join('\n')).toContain(`chose ${hex(101)} = 2`);
  });

  test('ack and choose refuse without a token file, making no request', async () => {
    for (const run of [
      () => runInboxAck(hex(201), {}, { fetchImpl: stubFetch({}), env: {}, ...capture() }),
      () => runInboxChoose(hex(101), '2', {}, { fetchImpl: stubFetch({}), env: {}, ...capture() }),
    ]) {
      const code = await run();
      expect(code).toBe(1);
    }
    const fetchImpl = stubFetch({});
    const io = capture();
    expect(await runInboxAck(hex(201), {}, { fetchImpl, env: {}, ...io })).toBe(1);
    expect(io.err.join('\n')).toContain('refusing: no token file');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('choose without a value refuses', async () => {
    const file = writeTokenFile('noval-token', 't\n');
    const fetchImpl = stubFetch({});
    const io = capture();
    expect(await runInboxChoose(hex(101), undefined, { tokenFile: file }, { fetchImpl, env: {}, ...io })).toBe(1);
    expect(io.err.join('\n')).toContain('a value is required');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('item line and pure helpers', () => {
  test('labels both ids when they differ and omits the label when they do not', () => {
    expect(formatItemLine(item(1))).toContain(`item=${hex(201)} source=${hex(101)}`);
    expect(formatItemLine({ ...item(2), id: hex(202) })).toContain(`item=${hex(202)} [`);
  });

  test('filterItems keeps an unparseable timestamp when no cursor is set', () => {
    const rows = [item(1, { createdAt: 'x' }), item(2)];
    expect(filterItems(rows, {})).toHaveLength(2);
    expect(filterItems(rows, { kind: 'mention' })).toHaveLength(2);
    expect(filterItems(rows, { kind: 'decision' })).toHaveLength(0);
  });

  test('nextCursorFrom falls back to the incoming cursor, not to null', () => {
    const given = { at: '2026-09-28T03:00:00.000Z', ms: Date.parse('2026-09-28T03:00:00.000Z'), ids: ['kept'] };
    expect(nextCursorFrom([], given)).toEqual(given);
    expect(nextCursorFrom([item(1, { createdAt: 'x' })], given)).toEqual(given);
  });

  test('nextCursorFrom records every id delivered at the newest millisecond', () => {
    const x = item(1);
    const y = item(1, { attentionItemId: hex(999) });
    const cursor = nextCursorFrom([x, y, item(4)], { at: x.createdAt, ms: Date.parse(x.createdAt), ids: ['earlier'] });
    // item(4) is newer, so the boundary is its own millisecond and the older ids
    // go: they can never match again.
    expect(cursor).toEqual({
      at: item(4).createdAt, ms: Date.parse(item(4).createdAt), ids: [item(4).attentionItemId], kind: null,
    });

    const sameMs = nextCursorFrom([x, y], { at: x.createdAt, ms: Date.parse(x.createdAt), ids: ['earlier'] });
    expect(sameMs.ids.sort()).toEqual([x.attentionItemId, y.attentionItemId, 'earlier'].sort());
  });

  test('parseCursor takes both shapes and refuses a malformed one by name', () => {
    const at = '2026-09-28T03:00:00.000Z';
    expect(parseCursor(at)).toEqual({
      at, ms: Date.parse(at), ids: [], kind: null,
    });
    expect(parseCursor(JSON.stringify({ at, ids: ['a', '', 7] })))
      .toEqual({
        at, ms: Date.parse(at), ids: ['a'], kind: null,
      });
    // Which query wrote the file is part of the cursor, not a side note.
    expect(parseCursor(JSON.stringify({ at, ids: [], kind: 'mention' })).kind).toBe('mention');
    expect(parseCursor(JSON.stringify({ at, ids: [], kind: 7 })).kind).toBeNull();
    expect(parseCursor(undefined)).toBeNull();
    expect(() => parseCursor('{oops')).toThrow('Not a cursor');
    expect(() => parseCursor('{"at":"yesterday"}')).toThrow('Not an ISO-8601 timestamp');
  });

  test('formatCursor round-trips through parseCursor, and writes kind only when there is one', () => {
    const at = '2026-09-28T03:00:00.000Z';
    const cursor = {
      at, ms: Date.parse(at), ids: ['a', 'b'], kind: null,
    };
    expect(parseCursor(formatCursor(cursor))).toEqual(cursor);
    expect(formatCursor(cursor)).not.toContain('kind');

    const scoped = { ...cursor, kind: 'mention' };
    expect(parseCursor(formatCursor(scoped))).toEqual(scoped);
    expect(formatCursor(scoped)).toContain('"kind":"mention"');
  });

  test('the redactor removes a real token and leaves a sentence alone', () => {
    const long = 'z'.repeat(24);
    expect(createScrubber(long)(`echo ${long} back`)).toBe('echo [redacted] back');
    // A short needle would rewrite unrelated words — measured: 't' turned
    // 'Attention item not found' into 'A[redacted][redacted]en[redacted]ion …'.
    expect(createScrubber('t')('Attention item not found')).toBe('Attention item not found');
  });

  test('registerInbox wires the three subcommands and their flags', () => {
    const program = new Command();
    program.exitOverride();
    expect(() => registerInbox(program)).not.toThrow();
    const inbox = program.commands.find((command) => command.name() === 'inbox');
    expect(inbox.commands.map((command) => command.name())).toEqual(['list', 'ack', 'choose']);
    const list = inbox.commands.find((command) => command.name() === 'list');
    expect(list.options.map((option) => option.long)).toEqual(expect.arrayContaining([
      '--token-file', '--since', '--cursor-file', '--kind', '--pod', '--json', '--instance',
    ]));
    // The help is where an operator learns the identity rule; a flag whose help
    // lost the env name would send them looking for a login instead.
    expect(list.options.find((option) => option.long === '--token-file').description)
      .toContain('COMMONLY_TOKEN_FILE');
    // outputHelp, not helpInformation: commander 12 appends `addHelpText('after')`
    // only on the output path, so asserting on helpInformation would pass with
    // the whole identity paragraph deleted.
    const printed = [];
    inbox.configureOutput({ writeOut: (text) => printed.push(text) });
    inbox.outputHelp();
    expect(printed.join('')).toContain('There is no fallback to the saved login');
  });
});
