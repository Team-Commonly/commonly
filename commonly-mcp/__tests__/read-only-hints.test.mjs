/**
 * Read-only tools carry the MCP `readOnlyHint: true` annotation, and the
 * server passes it through in tools/list. Hosts use the hint to skip the
 * approval prompt for reads on a server they mark untrusted (Hermes `trust:
 * untrusted`, for one), so every other tool still asks first.
 *
 * Read-only here means: no request at all, or GET requests only. A tool that
 * sends anything else must not carry the hint, so the second test derives the
 * list from the source and fails if a write tool is marked or a read is missed.
 */
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { buildTools } from '../src/tools.js';

const READ_ONLY = [
  'commonly_get_context', 'commonly_get_messages', 'commonly_get_posts',
  'commonly_get_started', 'commonly_get_tasks', 'commonly_get_ui_card_catalogue',
  'commonly_list_artifacts', 'commonly_list_files', 'commonly_list_pods',
  'commonly_read_agent_memory', 'commonly_read_file',
].sort();

const cfg = { baseUrl: 'https://x.example', token: 'cm_agent_t' };

test('tools/list marks exactly the read-only tools with readOnlyHint, and no other tool', async () => {
  const handle = createServer(cfg, { channel: false });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-host', version: '0.0.0' });
  await handle.connect(serverSide);
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  await client.close();
  const hinted = tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name).sort();
  expect(hinted).toEqual(READ_ONLY);
  // A write tool is never sent an annotation that claims otherwise.
  for (const t of tools.filter((x) => !READ_ONLY.includes(x.name))) {
    expect(t.annotations?.readOnlyHint).not.toBe(true);
  }
});

// What a tool's source sends: each request method (either quote style), and an
// upload as a write, since requestUpload always POSTs a file.
const sendsIn = (slice) => [
  ...[...slice.matchAll(/method:\s*(['"])([A-Z]+)\1/g)].map((m) => m[2]),
  ...[...slice.matchAll(/\brequestUpload\(/g)].map(() => 'UPLOAD'),
];

test('the derivation reads both quote styles and counts an upload as a write', () => {
  expect(sendsIn(`request(config, { method: "POST", path })`)).toEqual(['POST']);
  expect(sendsIn(`request(config, { method:'DELETE' })`)).toEqual(['DELETE']);
  expect(sendsIn(`await requestUpload(config, { path, file })`)).toEqual(['UPLOAD']);
  expect(sendsIn(`request(config, { method: 'GET', path })`)).toEqual(['GET']);
});

test('the hinted set is every tool that sends no request or GETs only', () => {
  const source = readFileSync(new URL('../src/tools.js', import.meta.url), 'utf8');
  const names = buildTools(cfg).map((t) => t.name);
  const starts = names.map((n) => source.search(new RegExp(`name:\\s*(['"])${n}\\1`)));
  expect(starts.every((s) => s >= 0)).toBe(true);
  const derived = names.filter((n, i) => {
    const end = starts.filter((s) => s > starts[i]).sort((a, b) => a - b)[0] ?? source.length;
    return sendsIn(source.slice(starts[i], end)).every((m) => m === 'GET');
  }).sort();
  expect(derived).toEqual(READ_ONLY);
});
