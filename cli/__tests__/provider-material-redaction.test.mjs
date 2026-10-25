import { redactProviderMaterial } from '../src/lib/provider-proxy.js';

test.each([1, 2, 7, 50])('provider material never reaches model output with chunk size %i', async (size) => {
  const material = 'sk-PRIVATE-provider-key';
  const input = Buffer.from(`before ${material} between ${material} after 中文`);
  const output = [];
  const stream = redactProviderMaterial(material);
  stream.on('data', (chunk) => output.push(chunk));
  const finished = new Promise((resolve) => stream.on('end', resolve));
  for (let index = 0; index < input.length; index += size) stream.write(input.subarray(index, index + size));
  stream.end(); await finished;
  expect(Buffer.concat(output).toString()).toBe('before [redacted] between [redacted] after 中文');
});

test('the live parent proxy resolves memory-only material and closes at spawn exit', async () => {
  const { createServer } = await import('node:http');
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { startProviderProxy } = await import('../src/lib/provider-proxy.js');
  const material = 'sk-OWN-KEY-private';
  let seen;
  const upstream = createServer((req, res) => {
    seen = req.headers.authorization;
    res.writeHead(401, { 'content-type': 'text/plain', 'x-echo': material });
    res.write(material.slice(0, 4)); res.end(material.slice(4));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const dir = await mkdtemp(join(tmpdir(), 'provider-material-'));
  let proxy;
  try {
    proxy = await startProviderProxy({ provider: { baseURL: `http://127.0.0.1:${upstream.address().port}/v1` },
      keyMaterial: material, keyFile: '/must-not-read', tokenFile: join(dir, 'bearer') });
    const token = await readFile(proxy.tokenFile, 'utf8');
    expect(token).not.toContain(material);
    const res = await fetch(`${proxy.baseURL}/chat/completions`, { method: 'POST',
      headers: { authorization: `Bearer ${token}` }, body: '{}' });
    expect(seen).toBe(`Bearer ${material}`);
    expect(await res.text()).toBe('[redacted]'); expect(res.headers.get('x-echo')).toBe('[redacted]');
    await proxy.close(); proxy = null;
    await expect(fetch(`${res.url}`)).rejects.toThrow();
  } finally {
    await proxy?.close(); await new Promise((resolve) => upstream.close(resolve)); await rm(dir, { recursive: true, force: true });
  }
});
