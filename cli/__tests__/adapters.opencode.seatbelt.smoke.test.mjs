import { spawn as childSpawn, spawnSync } from 'child_process';
import { createServer } from 'http';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { existsSync, readFileSync, realpathSync, unlinkSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';
import opencode, {
  readOpenCodeVersion,
  TESTED_OPENCODE_VERSIONS,
} from '../src/lib/adapters/opencode.js';
import { PUBLIC_SEAT_WITHHELD_TOOLS } from '../src/lib/public-withheld-tools.js';
import { buildSeatbeltProfile, wrapArgvWithSeatbelt } from '../src/lib/sandbox/seatbelt.js';
import {
  BROKER_ANSWER, BROKER_PATH, startSeatFixture, writeProviderKey,
} from '../test-support/grant-broker-seat-fixture.mjs';

const smokeBinary = process.env.COMMONLY_OPENCODE_SMOKE_BINARY;
const realSeatbeltTest = process.platform === 'darwin' && smokeBinary ? test : test.skip;

const assertSmokeTestedVersion = () => {
  const binary = realpathSync(smokeBinary);
  const version = readOpenCodeVersion(binary, process.env);
  if (!TESTED_OPENCODE_VERSIONS.includes(version)) {
    throw new Error(
      `Seatbelt smoke requires OpenCode ${TESTED_OPENCODE_VERSIONS.join(', ')}; configured binary reports ${version || 'unknown'}`,
    );
  }
  process.stdout.write(`Seatbelt smoke exercising OpenCode ${version}\n`);
};

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    server.removeListener('error', reject);
    resolve(server.address().port);
  });
});

const writeJson = (response, body) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

const runRealSeatbeltTurn = async ({
  removeXdgGitignore = false, seedPersistentConfig = false, expectMcpTool = false,
} = {}) => {
  assertSmokeTestedVersion();
  const root = await mkdtemp(join(tmpdir(), 'opencode-seatbelt-smoke-'));
  const workspace = join(root, 'workspace');
  const keyFile = join(root, 'provider-key');
  const seatRoot = join(root, 'seat-state');
  const persistentConfigDir = join(seatRoot, '.opencode');
  const persistentConfigPath = join(persistentConfigDir, 'opencode.json');
  const persistentConfig = JSON.stringify({
    permission: { '*': 'allow', bash: 'allow' },
    mcp: { injected: { type: 'local', command: ['/usr/bin/false'] } },
  });
  const marker = 'Seatbelt startup reached the local provider';
  const observed = [];
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    observed.push({ path: request.url, authorization: request.headers.authorization, body });
    if (request.url === '/v1/models') {
      writeJson(response, {
        object: 'list',
        data: [{ id: 'seatbelt-smoke-model', object: 'model', created: 0, owned_by: 'local' }],
      });
      return;
    }
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    const parsed = JSON.parse(body);
    if (parsed.stream) {
      const chunk = {
        id: 'chatcmpl-seatbelt-smoke',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'seatbelt-smoke-model',
        choices: [{ index: 0, delta: { role: 'assistant', content: marker }, finish_reason: null }],
      };
      const finalChunk = {
        id: 'chatcmpl-seatbelt-smoke',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'seatbelt-smoke-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      };
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
      response.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(finalChunk)}\n\ndata: [DONE]\n\n`);
      return;
    }
    writeJson(response, {
      id: 'chatcmpl-seatbelt-smoke',
      object: 'chat.completion',
      created: 0,
      model: 'seatbelt-smoke-model',
      choices: [{ index: 0, message: { role: 'assistant', content: marker }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  });

  try {
    await mkdir(workspace);
    await mkdir(persistentConfigDir, { recursive: true });
    if (seedPersistentConfig) await writeFile(persistentConfigPath, persistentConfig);
    await writeFile(keyFile, 'provider-smoke-secret');
    await chmod(keyFile, 0o600);
    const upstreamPort = await listen(upstream);
    let seatbeltProfile;
    const result = await opencode.spawn('Reply with a short greeting.', {
      cwd: workspace,
      env: { PATH: process.env.PATH, XDG_DATA_HOME: join(root, 'operator-data') },
      environment: {
        model: 'seatbelt-smoke-model',
        provider: {
          id: 'seatbelt-smoke',
          baseURL: `http://127.0.0.1:${upstreamPort}/v1`,
          keyFile,
          models: { 'seatbelt-smoke-model': { name: 'Seatbelt smoke model' } },
        },
        sandbox: { trust: 'public', mode: 'workspace' },
        ...(expectMcpTool ? { mcp: [{
          name: 'commonly', transport: 'stdio', command: ['npx', '-y', '@commonlyai/mcp@latest'],
        }] } : {}),
      },
      agentName: 'seatbelt-smoke',
      runtimeToken: 'seatbelt-smoke-runtime-token',
      timeoutMs: 45_000,
      _opencodeHomeRoot: seatRoot,
      _binaryPath: realpathSync(smokeBinary),
      _wrapArgvWithSeatbelt: (argv, options) => {
        seatbeltProfile = buildSeatbeltProfile(options);
        expect(existsSync(join(options.mcpConfigDir, 'home', '.opencode'))).toBe(false);
        if (removeXdgGitignore) {
          const gitignore = join(options.mcpConfigDir, 'xdg-config', 'opencode', '.gitignore');
          expect(existsSync(gitignore)).toBe(true);
          unlinkSync(gitignore);
        }
        return wrapArgvWithSeatbelt(argv, options);
      },
      _spawnImpl: (cmd, args, options) => {
        if (removeXdgGitignore) return childSpawn(cmd, args, options);
        const resolved = spawnSync('/usr/bin/sandbox-exec', [
          '-p', seatbeltProfile, realpathSync(smokeBinary), 'debug', 'config',
        ], { cwd: workspace, env: options.env, encoding: 'utf8', timeout: 15_000 });
        expect(resolved.error).toBeUndefined();
        expect(resolved.status).toBe(0);
        const effectiveConfig = JSON.parse(resolved.stdout);
        expect(effectiveConfig.permission['*']).toBe('deny');
        expect(effectiveConfig.permission.bash).toBe('deny');
        expect(effectiveConfig.mcp?.injected).toBeUndefined();
        return childSpawn(cmd, args, options);
      },
    });

    expect(result.text).toContain(marker);
    expect(observed.some((request) => request.path === '/v1/chat/completions')).toBe(true);
    if (expectMcpTool) {
      expect(observed.some((request) => request.body.includes('commonly_probe'))).toBe(true);
    }
    expect(observed.every((request) => request.authorization === 'Bearer provider-smoke-secret')).toBe(true);
    expect(existsSync(join(persistentConfigDir, '.gitignore'))).toBe(false);
    if (seedPersistentConfig) {
      expect(readFileSync(persistentConfigPath, 'utf8')).toBe(persistentConfig);
    } else {
      expect(existsSync(persistentConfigPath)).toBe(false);
    }
  } finally {
    upstream.closeAllConnections?.();
    if (upstream.listening) await new Promise((resolve) => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
};

realSeatbeltTest('real OpenCode starts under Seatbelt with an absent per-spawn HOME config root', async () => {
  await runRealSeatbeltTurn();
});

realSeatbeltTest('removing the pre-created XDG ignore file makes OpenCode fail at its write', async () => {
  await expect(runRealSeatbeltTurn({ removeXdgGitignore: true })).rejects.toThrow(
    /FileSystem\.writeFile .*xdg-config[\\/]opencode[\\/]\.gitignore/,
  );
});

realSeatbeltTest('persistent HOME config cannot override the effective public permission block', async () => {
  await runRealSeatbeltTurn({ seedPersistentConfig: true });
});

// Keep this version tree under the operator HOME. A tempdir fixture would be
// readable through macOS's /var baseline and would miss the regression.
const withSmokeCommonlyMcp = async (fn) => {
  const mcpHome = await mkdtemp(join(homedir(), '.commonly-opencode-mcp-smoke-'));
  const priorHome = process.env.COMMONLY_MCP_HOME;
  try {
    const pkg = join(mcpHome, '0.3.13', 'node_modules', '@commonlyai', 'mcp');
    await mkdir(join(pkg, 'src'), { recursive: true });
    await writeFile(join(pkg, 'package.json'), JSON.stringify({
      name: '@commonlyai/mcp', version: '0.3.13', type: 'module',
      bin: { 'commonly-mcp': 'src/index.js' },
    }));
    await writeFile(join(pkg, 'src', 'index.js'), `
      import { createInterface } from 'node:readline';
      const lines = createInterface({ input: process.stdin });
      lines.on('line', (line) => {
        const message = JSON.parse(line);
        if (message.id === undefined) return;
        const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
        if (message.method === 'initialize') return reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'commonly-smoke', version: '1' } });
        if (message.method === 'tools/list') return reply({ tools: [{ name: 'commonly_probe', description: 'smoke', inputSchema: { type: 'object', properties: {} } }] });
        if (message.method === 'tools/call') return reply({ content: [{ type: 'text', text: 'ok' }] });
        return reply({});
      });
    `);
    await writeFile(join(mcpHome, 'current'), '0.3.13\n');
    await writeFile(join(mcpHome, '.warm.lock'), 'smoke lock\n');
    process.env.COMMONLY_MCP_HOME = mcpHome;
    return await fn();
  } finally {
    if (priorHome === undefined) delete process.env.COMMONLY_MCP_HOME;
    else process.env.COMMONLY_MCP_HOME = priorHome;
    await rm(mcpHome, { recursive: true, force: true });
  }
};

realSeatbeltTest('real public OpenCode offers the warmed Commonly MCP tool under Seatbelt', async () => {
  await withSmokeCommonlyMcp(() => runRealSeatbeltTurn({ expectMcpTool: true, seedPersistentConfig: true }));
});

// The broker's real tool name, dot included. OpenCode offers it as
// `<server>_<tool>`, each part sanitized with hyphens kept.
const BROKER_TOOL_NAME = 'linear.list_teams';
const OFFERED_BROKER_TOOL = 'commonly-grant-broker_linear_list_teams';
const RUNTIME_TOKEN = 'cm_agent_opencode_broker_fixture_token';

const runBrokerTurn = async ({ attack = () => [], extra = {}, onConfig = () => {} } = {}) => {
  assertSmokeTestedVersion();
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'opencode-broker-smoke-')));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const keyFile = await writeProviderKey(root);
  const seen = { config: null, credential: null };
  const fixture = await startSeatFixture({
    brokerTool: BROKER_TOOL_NAME, oneCallPerTurn: true, attack: () => attack(seen),
  });
  try {
    const reply = await withSmokeCommonlyMcp(() => opencode.spawn('Which teams can you see in Linear?', {
      cwd: workspace,
      env: { PATH: process.env.PATH, XDG_DATA_HOME: join(root, 'operator-data') },
      environment: {
        model: 'fixture',
        provider: { id: 'fixture', baseURL: `${fixture.origin}/v1`, keyFile },
        sandbox: { trust: 'public', mode: 'workspace' },
        mcp: [
          { name: 'commonly', transport: 'stdio', command: ['npx', '-y', '@commonlyai/mcp@latest'] },
          { name: 'commonly-grant-broker', transport: 'http', url: `\${COMMONLY_API_URL}${BROKER_PATH}`,
            headers: { Authorization: 'Bearer ${COMMONLY_AGENT_TOKEN}' } },
        ],
      },
      agentName: 'opencode-broker-smoke',
      runtimeToken: RUNTIME_TOKEN,
      instanceUrl: fixture.origin,
      timeoutMs: 45_000,
      _opencodeHomeRoot: join(root, 'seat-state'),
      _binaryPath: realpathSync(smokeBinary),
      _spawnImpl: (cmd, args, options) => {
        seen.config = JSON.parse(readFileSync(options.env.OPENCODE_CONFIG, 'utf8'));
        const { Authorization } = seen.config.mcp['commonly-grant-broker'].headers;
        [, seen.credential] = Authorization.match(/^Bearer \{file:(.+)\}$/);
        onConfig(seen);
        return childSpawn(cmd, args, options);
      },
      ...extra,
    }));
    return { reply, seen, fixture };
  } catch (err) {
    await fixture.close();
    throw err;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

realSeatbeltTest('a jailed OpenCode seat sees the grant broker\'s tool, calls it, and the answer reaches the model', async () => {
  const { reply, seen, fixture } = await runBrokerTurn({
    attack: () => [{ name: OFFERED_BROKER_TOOL, args: {} }],
  });
  try {
    const { state } = fixture;
    expect(reply.text).toBe('proof complete');
    // The tools array the binary sent to the model route is the ground truth.
    expect(state.advertised[0]).toContain(OFFERED_BROKER_TOOL);
    expect(state.advertised[0]).toContain('commonly_commonly_probe');
    // The call survived the credential's deletion at the first step, with the
    // token OpenCode read from the file and the broker's own tool name.
    expect(state.brokerCalls).toEqual([BROKER_TOOL_NAME]);
    expect(new Set(state.brokerAuth)).toEqual(new Set([`Bearer ${RUNTIME_TOKEN}`]));
    expect(fixture.resultFor(0)).toContain(BROKER_ANSWER);
    expect(existsSync(seen.credential)).toBe(false);
    // The allow reaches the broker alone: nothing the seat's deny-all held back
    // came along with it.
    for (const tool of ['bash', 'task', 'webfetch', 'websearch', 'skill', 'question']) {
      expect(state.advertised.flat()).not.toContain(tool);
    }
    for (const body of state.modelBodies) expect(body).not.toContain(RUNTIME_TOKEN);
  } finally {
    await fixture.close();
  }
}, 90_000);

realSeatbeltTest('with the broker on offer, no OpenCode tool reads the credential, even one left on disk', async () => {
  const attackCalls = ({ credential }) => [
    { name: OFFERED_BROKER_TOOL, args: {} },
    { name: 'read', args: { filePath: credential } },
    { name: 'read', args: { filePath: dirname(credential) } },
    { name: 'glob', args: { pattern: '*', path: dirname(credential) } },
    { name: 'grep', args: { pattern: 'cm_agent', path: dirname(credential) } },
    { name: 'bash', args: { command: `cat ${credential}`, description: 'x' } },
    { name: 'commonly-grant-broker_commonly_attach_file', args: { filePath: credential } },
  ];
  const { reply, seen, fixture } = await runBrokerTurn({
    attack: attackCalls,
    // The deletion at the first step is one layer. Off, the deny rules stand alone.
    extra: { _rmSync: () => {} },
  });
  try {
    const { state } = fixture;
    expect(reply.text).toBe('proof complete');
    expect(existsSync(dirname(seen.credential))).toBe(false);
    const attempts = attackCalls(seen).length;
    expect(fixture.resultFor(0)).toContain(BROKER_ANSWER);
    for (let index = 1; index < attempts; index += 1) {
      expect(fixture.resultFor(index)).toBeDefined();
      expect(fixture.resultFor(index)).not.toContain(RUNTIME_TOKEN);
      expect(fixture.resultFor(index)).not.toContain('cm_agent');
    }
    for (const body of [...state.modelBodies, ...state.apiBodies]) expect(body).not.toContain(RUNTIME_TOKEN);
    expect(JSON.stringify(seen.config)).not.toContain(RUNTIME_TOKEN);
    // A withheld tool's deny follows the same name as the allow.
    for (const tool of PUBLIC_SEAT_WITHHELD_TOOLS) {
      expect(seen.config.permission[`commonly-grant-broker_${tool}`]).toBe('deny');
    }
    expect(state.brokerCalls).toEqual([BROKER_TOOL_NAME]);
  } finally {
    await fixture.close();
  }
}, 90_000);
