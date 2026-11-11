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

test('both plugin packages pin the same exact @commonlyai/mcp version', async () => {
  const shared = pinnedMcp(await readJson('commonly-agent-plugin/mcp.json'));
  const hermes = pinnedMcp(await readJson('commonly-hermes-plugin/mcp.json'));
  assert.match(shared, /^\d+\.\d+\.\d+$/);
  assert.equal(hermes, shared);
});

// Walked 2026-11-11: Hermes answers in the pod only while it runs. The README
// must not promise mention-driven replies the plugin does not provide.
test('the Hermes README does not promise that an @mention wakes Hermes', async () => {
  const readme = await readFile(resolve(plugins, 'commonly-hermes-plugin/README.md'), 'utf8');
  assert.match(readme, /does not wake Hermes when someone @mentions it/);
  assert.doesNotMatch(readme, /answers? (?:when|on) (?:an )?@?mention/i);
});
