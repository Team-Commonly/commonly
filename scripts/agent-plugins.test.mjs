import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const plugins = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'plugins');
const readJson = async (path) => JSON.parse(await readFile(resolve(plugins, path), 'utf8'));
const pinnedMcp = (mcp) => {
  const args = mcp.mcpServers.commonly.args;
  const spec = args.find((arg) => arg.startsWith('@commonlyai/mcp@'));
  assert.ok(spec, `no @commonlyai/mcp spec in ${JSON.stringify(args)}`);
  return spec.slice('@commonlyai/mcp@'.length);
};

// The Hermes plugin catalog admits a plugin only if its credentials come
// through Hermes (catalog rule 11), so the Hermes package must take the token
// from a declared Hermes secret, never from a file the user writes by hand.
test('the Hermes package takes the agent token from a Hermes secret, not a file', async () => {
  const mcp = await readJson('commonly-hermes-plugin/mcp.json');
  const env = mcp.mcpServers.commonly.env;
  assert.equal(env.COMMONLY_AGENT_TOKEN, '${COMMONLY_AGENT_TOKEN}');
  for (const [key, value] of Object.entries(env)) {
    assert.doesNotMatch(key, /_FILE$|_FD$/, `${key} would read the credential outside Hermes`);
    assert.doesNotMatch(String(value), /PLUGIN_DATA/, `${key} points into plugin data`);
  }
  const manifest = await readJson('commonly-hermes-plugin/plugin.json');
  const secrets = Object.values(manifest.extensions['com.nousresearch.hermes'].config_schema)
    .filter((field) => field.type === 'secret');
  assert.deepEqual(secrets.map((field) => [field.env, field.required]), [['COMMONLY_AGENT_TOKEN', true]]);
});

// A floating spec would run whatever npm publishes next, which no walk or
// catalog pin covers. Each package moves its pin on its own, after a walk.
test('each plugin package pins an exact @commonlyai/mcp version, and the Hermes README names it', async () => {
  for (const pkg of ['commonly-agent-plugin', 'commonly-hermes-plugin']) {
    assert.match(pinnedMcp(await readJson(`${pkg}/mcp.json`)), /^\d+\.\d+\.\d+$/, `plugins/${pkg}/mcp.json`);
  }
  const hermes = pinnedMcp(await readJson('commonly-hermes-plugin/mcp.json'));
  const readme = await readFile(resolve(plugins, 'commonly-hermes-plugin/README.md'), 'utf8');
  // Every version the README names is the pin: the disclosure and the self-hosted entry both name it.
  assert.deepEqual([...new Set([...readme.matchAll(/@commonlyai\/mcp@([\w.-]+)/g)].map((m) => m[1]))], [hermes]);
});

// Walked 2026-11-13 in Codex: a plugin install with no token file yet ended the
// server at start, and the person saw only that the Commonly tools were missing.
// Setup mode (opt-in) starts it with commonly_get_started, which names the file.
// 0.3.54 shipped setup mode before its fixes (relative path, no-URL start, cwd
// read on every start), so the pin is 0.3.55 or later. The Hermes package takes
// its token from a Hermes secret, never a file, so setup mode has no job there.
const atLeast = (version, floor) => {
  const [a, b] = [version, floor].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};
test('the Codex and Claude Code plugins turn setup mode on, with a pin that has its fixes', async () => {
  for (const file of ['commonly-agent-plugin/mcp.json', 'commonly/.claude-plugin/plugin.json']) {
    const mcp = await readJson(file);
    assert.equal(mcp.mcpServers.commonly.env.COMMONLY_MCP_SETUP_MODE, '1', file);
    assert.ok(mcp.mcpServers.commonly.env.COMMONLY_TOKEN_FILE, `${file}: setup mode applies only to a declared token file`);
    assert.ok(atLeast(pinnedMcp(mcp), '0.3.55'), `${file}: pin ${pinnedMcp(mcp)} predates the setup-mode fixes`);
  }
  // Hermes and Gemini take the token from the host's secret setting, never a
  // file, so setup mode has no job there.
  const hermes = await readJson('commonly-hermes-plugin/mcp.json');
  assert.equal(hermes.mcpServers.commonly.env.COMMONLY_MCP_SETUP_MODE, undefined);
  const gemini = await readJson('commonly-gemini/gemini-extension.json');
  assert.equal(gemini.mcpServers.commonly.env.COMMONLY_MCP_SETUP_MODE, undefined);
});

// Walked 2026-11-11: Hermes answers in the pod only while it runs. The README
// must not promise mention-driven replies the plugin does not provide.
test('the Hermes README does not promise that an @mention wakes Hermes', async () => {
  const readme = await readFile(resolve(plugins, 'commonly-hermes-plugin/README.md'), 'utf8');
  assert.match(readme, /does not wake Hermes when someone @mentions it/);
  // The exact sentence above is the real guard; this catches one common rewording.
  assert.doesNotMatch(readme, /answers? (?:when|on) (?:an )?@?mention/i);
});

// Hermes catalog review (11-12): the package asks Hermes to treat its server
// as untrusted, so every write prompts first, while the read-only tools
// (readOnlyHint in @commonlyai/mcp 0.3.51+) run without one. The README says so.
test('the Hermes package marks its server untrusted, and the README says writes ask first', async () => {
  const manifest = await readJson('commonly-hermes-plugin/plugin.json');
  assert.equal(manifest.extensions['com.nousresearch.hermes'].servers?.commonly?.trust, 'untrusted');
  const readme = await readFile(resolve(plugins, 'commonly-hermes-plugin/README.md'), 'utf8');
  assert.doesNotMatch(readme, /without asking/i);
  assert.match(readme, /asks before/i);
});

// Codex reads .codex-plugin/plugin.json, and so does the HOL scanner that
// gates catalog listings (it skips a plugin without one). The root plugin.json
// stays for Agent Plugins 1.0 readers. Both must say the same thing, and the
// Codex one must point at the MCP config and skills that ship (walked 11-12:
// with only .codex-plugin/plugin.json and no mcpServers pointer, Codex
// installed the plugin with no MCP server).
test('the Codex manifest matches the Agent Plugins manifest and points at what ships', async () => {
  const { $schema, ...root } = await readJson('commonly-agent-plugin/plugin.json');
  const { skills, mcpServers, ...codex } = await readJson('commonly-agent-plugin/.codex-plugin/plugin.json');
  assert.ok($schema);
  assert.deepEqual(codex, root);
  assert.equal(mcpServers, './mcp.json');
  assert.equal(skills, './skills/');
  await readJson(`commonly-agent-plugin/${mcpServers}`);
  await readFile(resolve(plugins, 'commonly-agent-plugin/skills/commonly/SKILL.md'), 'utf8');
});

// Gemini CLI extension (published as a copy at Team-Commonly/commonly-gemini,
// whose Sync workflow copies this directory daily). Walked 11-12 on gemini-cli
// 0.68.0: install asks for both settings, and the token reached the API as
// the server's bearer. The pin moves with the Claude plugin's, which is
// walked on each move, so the Gemini copy can't fall behind it.
test('the Gemini extension pins the same @commonlyai/mcp as the Claude plugin and takes every variable from a setting', async () => {
  const ext = await readJson('commonly-gemini/gemini-extension.json');
  const claude = await readJson('commonly/.claude-plugin/plugin.json');
  assert.equal(pinnedMcp(ext), pinnedMcp(claude));
  const declared = new Set(ext.settings.map((setting) => setting.envVar));
  const used = [...JSON.stringify(ext.mcpServers).matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(used)].sort(), [...declared].sort());
  assert.equal(ext.settings.find((setting) => setting.envVar === 'COMMONLY_AGENT_TOKEN').sensitive, true);
  assert.equal(ext.mcpServers.commonly.env.COMMONLY_MCP_CHANNEL, '0');
});

test('the Gemini README does not promise that an @mention wakes Gemini CLI', async () => {
  const readme = await readFile(resolve(plugins, 'commonly-gemini/README.md'), 'utf8');
  assert.match(readme, /nothing wakes Gemini CLI when someone @mentions/);
  assert.doesNotMatch(readme, /answers? (?:when|on) (?:an )?@?mention/i);
});
