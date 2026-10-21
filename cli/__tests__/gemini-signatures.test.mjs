/**
 * Gemini's thought signatures round-trip through the provider proxy
 * (TASK-251; approach from magpie, MIT). Gemini 3 refuses the next request of a
 * tool loop without the signature back on the call, and OpenCode's provider
 * drops the field, so the proxy carries a reference in the call's id.
 */
import { createServer } from 'http';
import {
  chmod, mkdtemp, readdir, rm, stat, utimes, writeFile,
} from 'fs/promises';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SKIP_SIGNATURE,
  createReplySigner,
  createSignatureStore,
  isGeminiOpenAIUpstream,
  restoreRequestSignatures,
  signedId,
  unsignedId,
} from '../src/lib/gemini-signatures.js';
import { startProviderProxy } from '../src/lib/provider-proxy.js';

const SIG = 'CiQB4dpSignatureBytes+/==';
const KEY = 'AAAAAAAAAAAAAAAA';

let root;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'cli-gemini-sig-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('the reference in a call id', () => {
  test('round-trips, and leaves a plain id as it is', () => {
    expect(unsignedId(signedId('call_1', KEY))).toEqual({ id: 'call_1', key: KEY });
    expect(unsignedId('call_1')).toEqual({ id: 'call_1', key: null });
  });

  test('an id a client shortened is no signature, not some other key', () => {
    const cut = signedId('call_1', KEY).slice(0, -3);
    expect(unsignedId(cut)).toEqual({ id: cut, key: null });
  });

  test('a mark whose stated length is wrong, or whose key is not 16 long, is no signature', () => {
    expect(unsignedId('call_1__cmts15__AAAAAAAAAAAAAAAA').key).toBeNull();
    expect(unsignedId('call_1__cmts3__abc').key).toBeNull();
  });

  test('only Gemini\'s OpenAI-compatible host turns it on', () => {
    expect(isGeminiOpenAIUpstream('https://generativelanguage.googleapis.com/v1beta/openai')).toBe(true);
    expect(isGeminiOpenAIUpstream('https://api.deepseek.com/v1')).toBe(false);
    expect(isGeminiOpenAIUpstream('not a url')).toBe(false);
  });
});

describe('the signature store', () => {
  test('a later spawn finds what an earlier one kept, in 0600 files under a 0700 dir', async () => {
    const dir = join(root, 'sigs');
    const key = await createSignatureStore(dir).keep(SIG);
    expect(await createSignatureStore(dir).lookup(key)).toBe(SIG);
    // eslint-disable-next-line no-bitwise
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    // eslint-disable-next-line no-bitwise
    expect((await stat(join(dir, key))).mode & 0o777).toBe(0o600);
  });

  test('a file that does not hash to its name is no signature', async () => {
    const dir = join(root, 'sigs');
    const key = await createSignatureStore(dir).keep(SIG);
    await writeFile(join(dir, key), 'something else');
    expect(await createSignatureStore(dir).lookup(key)).toBeNull();
  });

  test('without a dir it is this spawn only', async () => {
    const key = await createSignatureStore().keep(SIG);
    expect(await createSignatureStore().lookup(key)).toBeNull();
  });

  test('prune removes signatures not read for 30 days and old staged files', async () => {
    const dir = join(root, 'sigs');
    const store = createSignatureStore(dir);
    const fresh = await store.keep('fresh');
    const old = await store.keep('old');
    await writeFile(join(dir, 'x.tmp'), '');
    const longAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await utimes(join(dir, old), longAgo, longAgo);
    await utimes(join(dir, 'x.tmp'), longAgo, longAgo);
    await store.prune();
    expect((await readdir(dir)).sort()).toEqual([fresh]);
  });
});

describe('restoring signatures on a request', () => {
  const body = (messages) => Buffer.from(JSON.stringify({ model: 'gemini-3', messages }));
  const parsed = (buffer) => JSON.parse(buffer.toString('utf8')).messages;

  test('a referenced call gets its own id back and its signature in extra_content; its result answers that id', async () => {
    const store = createSignatureStore();
    const key = await store.keep(SIG);
    const out = parsed(await restoreRequestSignatures(body([
      { role: 'assistant', tool_calls: [{ id: signedId('call_1', key), type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: signedId('call_1', key), content: 'ok' },
    ]), store));
    expect(out[0].tool_calls[0]).toMatchObject({ id: 'call_1', extra_content: { google: { thought_signature: SIG } } });
    expect(out[1].tool_call_id).toBe('call_1');
  });

  test('in a signed step only the signed (first) call carries it; a step with none gets the skip value on every call', async () => {
    const store = createSignatureStore();
    const key = await store.keep(SIG);
    const out = parsed(await restoreRequestSignatures(body([
      { role: 'assistant', tool_calls: [{ id: signedId('a', key) }, { id: 'b' }] },
      { role: 'assistant', tool_calls: [{ id: 'c' }, { id: 'd' }] },
    ]), store));
    expect(out[0].tool_calls[0].extra_content.google.thought_signature).toBe(SIG);
    expect(out[0].tool_calls[1].extra_content).toBeUndefined();
    expect(out[1].tool_calls.map((call) => call.extra_content.google.thought_signature)).toEqual([SKIP_SIGNATURE, SKIP_SIGNATURE]);
  });

  test('a reference the store no longer has is unsigned history, not a failure', async () => {
    const out = parsed(await restoreRequestSignatures(body([
      { role: 'assistant', tool_calls: [{ id: signedId('call_1', KEY) }] },
    ]), createSignatureStore()));
    expect(out[0].tool_calls[0]).toMatchObject({ id: 'call_1', extra_content: { google: { thought_signature: SKIP_SIGNATURE } } });
  });

  test('a body that is not JSON, or needs nothing, is sent as it came', async () => {
    const store = createSignatureStore();
    const notJson = Buffer.from('not json');
    expect(await restoreRequestSignatures(notJson, store)).toBe(notJson);
    const plain = body([{ role: 'user', content: 'hi' }]);
    expect(await restoreRequestSignatures(plain, store)).toBe(plain);
  });
});

describe('signing a reply', () => {
  const chunk = (delta) => `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`;

  test('a streamed call with a signature gets a referencing id; every other line passes byte for byte', async () => {
    const store = createSignatureStore();
    const signer = createReplySigner({ store, sse: true });
    const text = chunk({ content: 'héllo' })
      + chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' }, extra_content: { google: { thought_signature: SIG } } }] })
      + 'data: [DONE]\n\n';
    const bytes = Buffer.from(text, 'utf8');
    // Split inside "é" and inside the signed line, the way a socket might.
    const cutA = bytes.indexOf(Buffer.from('é')) + 1;
    const cutB = bytes.indexOf(Buffer.from('thought_signature')) + 5;
    const out = (await signer.write(bytes.subarray(0, cutA)))
      + (await signer.write(bytes.subarray(cutA, cutB)))
      + (await signer.write(bytes.subarray(cutB)))
      + (await signer.end());
    const lines = out.split('\n');
    expect(lines[0]).toBe(chunk({ content: 'héllo' }).split('\n')[0]);
    const call = JSON.parse(lines[2].slice(6)).choices[0].delta.tool_calls[0];
    const { id, key } = unsignedId(call.id);
    expect(id).toBe('call_1');
    expect(await store.lookup(key)).toBe(SIG);
    expect(out.endsWith('data: [DONE]\n\n')).toBe(true);
  });

  test('a whole JSON reply is signed at the end', async () => {
    const store = createSignatureStore();
    const signer = createReplySigner({ store, sse: false });
    const reply = JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'call_9', extra_content: { google: { thought_signature: SIG } } }] } }] });
    expect(await signer.write(Buffer.from(reply))).toBe('');
    const call = JSON.parse(await signer.end()).choices[0].message.tool_calls[0];
    expect(unsignedId(call.id).id).toBe('call_9');
  });

  test('a reply with no signature is unchanged', async () => {
    const signer = createReplySigner({ store: createSignatureStore(), sse: false });
    const reply = '{"choices":[{"message":{"content":"ok"}}]}';
    await signer.write(Buffer.from(reply));
    expect(await signer.end()).toBe(reply);
  });
});

describe('through the provider proxy', () => {
  const startUpstream = async (handler) => {
    const seen = [];
    const server = createServer((req, res) => {
      const parts = [];
      req.on('data', (c) => parts.push(c));
      req.on('end', () => {
        seen.push({ headers: req.headers, body: Buffer.concat(parts).toString('utf8') });
        handler(seen.length, res);
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, seen, port: server.address().port };
  };

  const startProxy = async (port, signatureStore) => {
    const keyFile = join(root, 'key');
    await writeFile(keyFile, 'upstream-secret');
    await chmod(keyFile, 0o600);
    const tokenFile = join(root, 'token');
    const proxy = await startProviderProxy({
      provider: { baseURL: `http://127.0.0.1:${port}/v1beta/openai` }, keyFile, tokenFile, signatureStore,
    });
    return { proxy, token: readFileSync(tokenFile, 'utf8') };
  };

  const post = (proxy, token, body) => fetch(`${proxy.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  test('the signature from a streamed reply is back on the next request, with the call\'s own id', async () => {
    const up = await startUpstream((n, res) => {
      if (n === 1) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'fc_1', type: 'function', function: { name: 'commonly_get_context', arguments: '{}' }, extra_content: { google: { thought_signature: SIG } } }] } }] })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"choices":[{"message":{"content":"done"}}]}');
    });
    const { proxy, token } = await startProxy(up.port, createSignatureStore(join(root, 'sigs')));
    try {
      const first = await (await post(proxy, token, { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] })).text();
      const call = JSON.parse(first.split('\n')[0].slice(6)).choices[0].delta.tool_calls[0];
      expect(call.id).not.toBe('fc_1');
      // What OpenCode sends back: the id it was given, and no extra_content.
      const second = await post(proxy, token, {
        model: 'm',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', tool_calls: [{ id: call.id, type: 'function', function: call.function }] },
          { role: 'tool', tool_call_id: call.id, content: '{}' },
        ],
      });
      expect(await second.text()).toBe('{"choices":[{"message":{"content":"done"}}]}');
      const sent = JSON.parse(up.seen[1].body).messages;
      expect(sent[1].tool_calls[0]).toMatchObject({ id: 'fc_1', extra_content: { google: { thought_signature: SIG } } });
      expect(sent[2].tool_call_id).toBe('fc_1');
      expect(up.seen[1].headers['content-length']).toBe(String(Buffer.byteLength(up.seen[1].body)));
      expect(up.seen.every((r) => r.headers['accept-encoding'] === 'identity')).toBe(true);
    } finally {
      await proxy.close();
      await new Promise((resolve) => up.server.close(resolve));
    }
  });

  test('without a store, requests and replies pass unchanged, as for any other provider', async () => {
    const reply = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: 'fc_1', extra_content: { google: { thought_signature: SIG } } }] } }] })}\n\n`;
    const up = await startUpstream((n, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(reply);
    });
    const { proxy, token } = await startProxy(up.port, null);
    try {
      expect(await (await post(proxy, token, { messages: [{ role: 'assistant', tool_calls: [{ id: signedId('x', KEY) }] }] })).text()).toBe(reply);
      expect(JSON.parse(up.seen[0].body).messages[0].tool_calls[0]).toEqual({ id: signedId('x', KEY) });
      expect(up.seen[0].headers['accept-encoding']).not.toBe('identity');
    } finally {
      await proxy.close();
      await new Promise((resolve) => up.server.close(resolve));
    }
  });
});
