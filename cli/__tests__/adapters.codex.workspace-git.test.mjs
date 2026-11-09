/**
 * A public Codex seat reads its workspace's history through the read-only git
 * tool, on the real `codex` binary. Its shell can't run git on macOS (Homebrew's
 * git is outside the profile and /usr/bin/git is an xcrun shim), so this tool is
 * the seat's only way to read a commit.
 *
 * Codex starts MCP servers outside the seat's permission profile, so the tool
 * has a Seatbelt of its own. These tests check that it holds: a filter the
 * repository's config defines can't write outside the workspace, and the files
 * the seat's profile denies don't come back through git.
 *
 * The model is a stub on loopback, as in adapters.codex.public-tools.test.mjs.
 * Runs only where `codex` and `git` are on PATH, on macOS.
 */

import { jest } from '@jest/globals';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import {
  appendFile, mkdtemp, mkdir, rm, writeFile,
} from 'fs/promises';
import http from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import codex from '../src/lib/adapters/codex.js';

jest.setTimeout(90000);

const hasTools = process.platform === 'darwin'
  && spawnSync('codex', ['--version'], { encoding: 'utf8' }).status === 0
  && spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
if (!hasTools) console.warn('adapters.codex.workspace-git: no codex or git on this Mac or platform, real-binary checks skipped');
const describeWithCodex = hasTools ? describe : describe.skip;

const SUBJECT = 'a subject only git can show';
const SECRET = 'SECRET-NPM-TOKEN-0f3a';

const startModel = async (reply) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      if (req.method !== 'POST' || !/\/responses$/.test(req.url)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      const items = (await reply(requests.length - 1, body)) || [{
        type: 'message', role: 'assistant', id: 'm1', content: [{ type: 'output_text', text: 'done' }],
      }];
      const id = `r${requests.length}`;
      const events = [
        { type: 'response.created', response: { id } },
        ...items.map((item) => ({ type: 'response.output_item.done', item })),
        { type: 'response.completed', response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
  });
  server.on('connect', (req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return {
    requests,
    port: server.address().port,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
};

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

const outputOf = (body, callId) => JSON.stringify(
  body.input.find((item) => item.call_id === callId && /output/.test(item.type))?.output ?? null,
);

describeWithCodex('a public codex seat and the workspace git tool, on the real binary', () => {
  let root;
  let workspace;
  let model;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'commonly-codex-git-'));
    await Promise.all(['workspace', 'home', 'operator', 'outside'].map((dir) => mkdir(join(root, dir))));
    await writeFile(
      join(root, 'operator', 'auth.json'),
      JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'stub-key' }),
    );
    workspace = join(root, 'workspace');
    git(workspace, 'init', '-q');
    await writeFile(join(workspace, 'a.txt'), 'one\n');
    await writeFile(join(workspace, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
    git(workspace, 'add', 'a.txt', '.npmrc');
    git(workspace, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', SUBJECT);
  });

  afterEach(async () => {
    await model?.close();
    model = null;
    await rm(root, { recursive: true, force: true });
  });

  const runTurn = async (reply) => {
    model = await startModel(reply);
    const proxy = `http://127.0.0.1:${model.port}`;
    await codex.spawn('hi', {
      cwd: workspace,
      agentName: 'workspace-git-test',
      timeoutMs: 80000,
      environment: { model: 'gpt-5.5', sandbox: { trust: 'public', mode: 'workspace' } },
      env: {
        PATH: process.env.PATH,
        HOME: join(root, 'home'),
        TMPDIR: tmpdir(),
        CODEX_HOME: join(root, 'operator'),
        OPENAI_BASE_URL: `${proxy}/v1`,
        HTTPS_PROXY: proxy,
        HTTP_PROXY: proxy,
        ALL_PROXY: proxy,
        NO_PROXY: '127.0.0.1,localhost',
      },
      _publicCodexHome: join(root, 'public'),
    });
    return model.requests;
  };

  // Codex starts MCP servers alongside the turn, so the first search can come
  // before the tool is listed. The stub searches again, a little later, until
  // it is, then makes the calls in `calls` one per turn.
  const gitCalls = (calls) => {
    let namespace = null;
    let next = 0;
    let searches = 0;
    return async (index, body) => {
      if (!namespace) {
        const found = body.input.filter((item) => item.type === 'tool_search_output').at(-1);
        namespace = found?.tools?.find((tool) => /workspace_git/.test(tool.name || ''))?.name || null;
      }
      if (!namespace) {
        if (searches >= 10) return null;
        if (searches > 0) await new Promise((resolve) => { setTimeout(resolve, 500); });
        searches += 1;
        return [{
          type: 'tool_search_call',
          call_id: `search-${searches}`,
          status: 'completed',
          execution: 'client',
          arguments: { query: 'workspace git log', limit: 10 },
        }];
      }
      if (next >= calls.length) return null;
      const [callId, subcommand, args] = calls[next];
      next += 1;
      return [{
        type: 'function_call', namespace, name: 'git', call_id: callId, arguments: JSON.stringify({ subcommand, args }),
      }];
    };
  };

  test('the seat finds the git tool and reads a commit through it', async () => {
    const requests = await runTurn(gitCalls([['log', 'log', ['-n', '1', '--format=%s']]]));
    expect(outputOf(requests.at(-1), 'log')).toContain(SUBJECT);
  });

  test('the shell still cannot run git, so the tool is not a way around it', async () => {
    const requests = await runTurn((index) => (index === 0
      ? [{
        type: 'function_call',
        name: 'exec_command',
        call_id: 'shell',
        arguments: JSON.stringify({ cmd: 'git log -n 1 --format=%s', yield_time_ms: 5000 }),
      }]
      : null));
    const output = outputOf(requests.at(-1), 'shell');
    expect(output).not.toBe('null');
    expect(output).not.toContain(SUBJECT);
  });

  test('a file the seat\'s profile denies does not come back through git', async () => {
    await appendFile(join(workspace, '.npmrc'), `//registry.npmjs.org/:_authToken=${SECRET}\n`);
    const requests = await runTurn(gitCalls([
      ['diff', 'diff', []],
      ['show', 'show', ['HEAD:.npmrc']],
      ['blame', 'blame', ['.npmrc']],
      ['status', 'status', ['--short']],
    ]));
    const last = requests.at(-1);
    expect(outputOf(last, 'diff')).not.toContain(SECRET);
    expect(outputOf(last, 'show')).toMatch(/refused/);
    expect(outputOf(last, 'blame')).toMatch(/refused/);
    expect(outputOf(last, 'status')).not.toContain('.npmrc');
    expect(JSON.stringify(last.input)).not.toContain(SECRET);
  });

  test('a filter the repository defines runs inside the tool\'s sandbox', async () => {
    // Set up on the host, as a repository a seat was given could already carry.
    const marker = join(root, 'outside', 'filter-ran');
    git(workspace, 'config', 'filter.probe.clean', `sh -c 'touch ${marker}; cat'`);
    await writeFile(join(workspace, '.gitattributes'), 'a.txt filter=probe\n');
    await appendFile(join(workspace, 'a.txt'), 'two\n');
    const requests = await runTurn(gitCalls([['status', 'status', ['--short']], ['diff', 'diff', []]]));
    expect(outputOf(requests.at(-1), 'diff')).toContain('two');
    expect(existsSync(marker)).toBe(false);
  });
});
