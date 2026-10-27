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

const collect = async (redactor, input, size) => {
  const output = [];
  redactor.on('data', (chunk) => output.push(chunk));
  const finished = new Promise((resolve) => redactor.on('end', resolve));
  for (let index = 0; index < input.length; index += size) redactor.write(input.subarray(index, index + size));
  redactor.end(); await finished;
  return Buffer.concat(output).toString();
};

// The redactor as it was before it released early: hold the last
// (key length - 1) bytes, always. The current one must match it byte for byte.
const { Transform } = await import('node:stream');
const holdKeyLength = (material) => {
  const secret = Buffer.from(material);
  let pending = Buffer.alloc(0);
  return new Transform({
    transform(chunk, _encoding, done) {
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      while (pending.length >= secret.length) {
        const index = pending.indexOf(secret);
        if (index >= 0) {
          this.push(pending.subarray(0, index)); this.push('[redacted]');
          pending = pending.subarray(index + secret.length);
        } else {
          const count = pending.length - secret.length + 1;
          this.push(pending.subarray(0, count)); pending = pending.subarray(count);
        }
      }
      done();
    },
    flush(done) { this.push(pending); pending = Buffer.alloc(0); done(); },
  });
};

// A seeded generator, so a failing stream can be replayed.
const seeded = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

test.each(['', Buffer.alloc(0)])('refuses empty material instead of scanning forever (%p)', (material) => {
  expect(() => redactProviderMaterial(material)).toThrow(TypeError);
});

test('releases bytes that cannot start the key at once, and holds only a possible key prefix', async () => {
  const material = 'sk-PRIVATE-provider-key';
  const output = [];
  const stream = redactProviderMaterial(material);
  stream.on('data', (chunk) => output.push(chunk.toString()));
  stream.write('data: {"token":"hi"}\n\n');
  await new Promise((resolve) => setImmediate(resolve));
  expect(output.join('')).toBe('data: {"token":"hi"}\n\n');
  stream.write('then sk-PRI');
  await new Promise((resolve) => setImmediate(resolve));
  expect(output.join('')).toBe('data: {"token":"hi"}\n\nthen ');
  stream.write('VATE-provider-key done');
  stream.end();
  await new Promise((resolve) => stream.on('end', resolve));
  expect(output.join('')).toBe('data: {"token":"hi"}\n\nthen [redacted] done');
});

test('redacts a key split at every byte boundary', async () => {
  const material = 'sk-PRIVATE-provider-key';
  for (let cut = 1; cut < material.length; cut += 1) {
    const stream = redactProviderMaterial(material);
    const output = [];
    stream.on('data', (chunk) => output.push(chunk));
    const finished = new Promise((resolve) => stream.on('end', resolve));
    stream.write(`a ${material.slice(0, cut)}`); stream.end(`${material.slice(cut)} b`);
    await finished; // eslint-disable-line no-await-in-loop
    expect(Buffer.concat(output).toString()).toBe('a [redacted] b');
  }
});

describe('matches the hold-key-length redactor byte for byte', () => {
  const KEY = `sk-ant-api03-${'ab'.repeat(46)}`;
  const cases = [`x${KEY}y`, `${KEY}${KEY}`, `sk-ant-${KEY}`, `${KEY.slice(0, -1)}!`,
    `aaa${KEY.slice(0, 5)}`, 'plain text no key', KEY];
  test.each(cases.flatMap((input) => [1, 2, 7, 50, 1000].map((size) => [input.slice(0, 24), size, input])))(
    '%s at chunk size %i',
    async (_label, size, input) => {
      const got = await collect(redactProviderMaterial(KEY), Buffer.from(input), size);
      expect(got).toBe(await collect(holdKeyLength(KEY), Buffer.from(input), size));
      expect(got).not.toContain(KEY);
    },
  );

  test('on 2,000 random streams of key fragments', async () => {
    const random = seeded(2753);
    for (let n = 0; n < 2000; n += 1) {
      const parts = [];
      for (let k = 0; k < 6; k += 1) {
        parts.push(random() < 0.3 ? KEY.slice(0, Math.floor(random() * KEY.length) + 1)
          : random().toString(36).slice(2));
      }
      const input = Buffer.from(parts.join(''));
      const size = 1 + Math.floor(random() * 60);
      /* eslint-disable no-await-in-loop */
      expect([n, await collect(redactProviderMaterial(KEY), input, size)])
        .toEqual([n, await collect(holdKeyLength(KEY), input, size)]);
      /* eslint-enable no-await-in-loop */
    }
  });

  // Keys over a two-letter alphabet overlap themselves, the hard case for
  // deciding which held bytes could still start a match.
  test('on 2,000 random streams with self-overlapping keys', async () => {
    const random = seeded(4000);
    const word = (length) => Array.from({ length }, () => (random() < 0.5 ? 'a' : 'b')).join('');
    for (let n = 0; n < 2000; n += 1) {
      const key = word(1 + Math.floor(random() * 12));
      const input = Buffer.from(word(Math.floor(random() * 80)));
      const size = 1 + Math.floor(random() * 9);
      /* eslint-disable no-await-in-loop */
      const got = await collect(redactProviderMaterial(key), input, size);
      expect([n, key, got]).toEqual([n, key, await collect(holdKeyLength(key), input, size)]);
      expect(got.replace(/\[redacted\]/g, '|')).not.toContain(key);
      /* eslint-enable no-await-in-loop */
    }
  });
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
