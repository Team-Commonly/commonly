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

test('the hinted set is every tool that sends no request or GETs only', () => {
  const source = readFileSync(new URL('../src/tools.js', import.meta.url), 'utf8');
  const names = buildTools(cfg).map((t) => t.name);
  const starts = names.map((n) => source.indexOf(`name: '${n}'`));
  const derived = names.filter((n, i) => {
    const end = starts.filter((s) => s > starts[i]).sort((a, b) => a - b)[0] ?? source.length;
    const methods = [...source.slice(starts[i], end).matchAll(/method: '([A-Z]+)'/g)].map((m) => m[1]);
    return methods.every((m) => m === 'GET');
  }).sort();
  expect(derived).toEqual(READ_ONLY);
});
