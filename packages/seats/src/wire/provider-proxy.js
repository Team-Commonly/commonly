import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
/** The per-spawn loopback proxy shared by OpenAI-compatible CLI adapters. */
import { randomBytes, timingSafeEqual } from 'crypto';
import { constants as fsConstants, realpathSync } from 'fs';
import { createServer, request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { chmod, lstat, open, unlink, writeFile } from 'fs/promises';
import { isAbsolute, relative, sep } from 'path';

// Providers sometimes echo request headers in an error response. Redact the
// material across arbitrary stream chunk boundaries before any model sees it.
export const redactProviderMaterial = (material) => {
  const secret = Buffer.from(material);
  // An empty key matches everywhere and the scan below would never advance.
  if (secret.length === 0) throw new TypeError('provider material to redact is empty');
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
      // Hold back only the longest tail that could still start the key, so a
      // streamed token is not delayed until a key's length of bytes follows it.
      let keep = Math.min(pending.length, secret.length - 1);
      while (keep > 0 && !pending.subarray(pending.length - keep).equals(secret.subarray(0, keep))) keep -= 1;
      if (pending.length > keep) {
        this.push(pending.subarray(0, pending.length - keep)); pending = pending.subarray(pending.length - keep);
      }
      done();
    },
    flush(done) { this.push(pending); pending = Buffer.alloc(0); done(); },
  });
};

const MAX_PINNED_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_PINNED_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * Checks that every completion an upstream serves names the pinned model.
 * SSE is checked line by line, and nothing is released until a line has named
 * the pinned model; after that only checked lines are released, so a chunk
 * naming another model never reaches the CLI. Any other body is held whole and
 * released only after its `model` is checked. A body that names no model is
 * unverified, which counts as a failure: the pin is only as good as the check.
 */
const servedModelCheck = ({ pinned, stream, onServed }) => {
  // A chunk boundary can fall inside a multi-byte character; the decoder
  // carries the partial bytes into the next chunk instead of mangling both.
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let held = '';
  let named = false;
  let size = 0;
  const check = (value) => {
    if (typeof value !== 'string') return;
    named = true;
    onServed(value);
    if (value !== pinned) throw new Error(`served model ${JSON.stringify(value)} is not the pinned ${JSON.stringify(pinned)}`);
  };
  const checkLine = (line) => {
    const data = /^data:\s?(.*)$/.exec(line.replace(/\r$/, ''))?.[1];
    if (data === undefined || data.trim() === '[DONE]' || !data.trim()) return;
    let parsed;
    try { parsed = JSON.parse(data); } catch { return; }
    check(parsed?.model);
  };
  return new Transform({
    transform(chunk, _encoding, done) {
      size += chunk.length;
      if (size > MAX_PINNED_RESPONSE_BYTES) { done(new Error('provider response exceeded the pinned-model check limit')); return; }
      pending += decoder.write(chunk);
      if (!stream) { done(); return; }
      const end = pending.lastIndexOf('\n');
      if (end < 0) { done(); return; }
      const complete = pending.slice(0, end + 1);
      pending = pending.slice(end + 1);
      try { complete.split('\n').forEach(checkLine); } catch (error) { done(error); return; }
      held += complete;
      if (!named) { done(); return; }
      const release = held;
      held = '';
      done(null, release);
    },
    flush(done) {
      pending += decoder.end();
      try {
        if (stream) checkLine(pending);
        else {
          let parsed;
          try { parsed = JSON.parse(pending); } catch { parsed = null; }
          check(parsed?.model);
        }
        if (!named) throw new Error(`provider response named no model; the pinned ${JSON.stringify(pinned)} cannot be verified`);
      } catch (error) { done(error); return; }
      done(null, held + pending);
    },
  });
};

const isPathWithin = (parent, candidate) => {
  const fromParent = relative(parent, candidate);
  return fromParent === '' || (fromParent !== '..'
    && !fromParent.startsWith(`..${sep}`)
    && !isAbsolute(fromParent));
};
/** Validate the key path without reading the key. The proxy reads it at spawn. */
export const resolveProviderKeyFile = async (provider, workspacePath, adapterLabel = 'OpenCode') => {
  if (!provider) return null;
  const keyFile = provider.keyFile;
  if (typeof keyFile !== 'string' || !isAbsolute(keyFile)) {
    throw new Error(`${adapterLabel} provider.keyFile must be an absolute path`);
  }
  if (/[\r\n}]/.test(keyFile)) {
    throw new Error(`${adapterLabel} provider.keyFile contains characters unsafe for a file reference`);
  }
  let details;
  try {
    details = await lstat(keyFile);
  } catch (err) {
    throw new Error(`${adapterLabel} provider key file is unavailable: ${err.message}`);
  }
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error(`${adapterLabel} provider.keyFile must be a regular, non-symlink file`);
  }
  if ((details.mode & 0o777) !== 0o600) {
    throw new Error(`${adapterLabel} provider.keyFile must have mode 0600`);
  }
  if (typeof workspacePath !== 'string' || !isAbsolute(workspacePath)) {
    throw new Error(`${adapterLabel} provider.keyFile requires an absolute workspace path`);
  }
  let realKeyFile;
  let realWorkspace;
  try {
    realKeyFile = realpathSync(keyFile);
    realWorkspace = realpathSync(workspacePath);
  } catch (err) {
    throw new Error(`${adapterLabel} provider key path could not be resolved: ${err.message}`);
  }
  if (isPathWithin(realWorkspace, realKeyFile)) {
    throw new Error(`${adapterLabel} provider.keyFile must be outside the workspace`);
  }
  return realKeyFile;
};

const readProviderKey = async (keyFile, adapterLabel) => {
  const noFollow = fsConstants.O_NOFOLLOW || 0;
  const handle = await open(keyFile, fsConstants.O_RDONLY | noFollow);
  try {
    const details = await handle.stat();
    if (!details.isFile() || (details.mode & 0o777) !== 0o600) {
      throw new Error(`${adapterLabel} provider.keyFile changed after validation; expected a regular mode-0600 file`);
    }
    const value = (await handle.readFile()).toString('utf8').trim();
    if (!value) throw new Error(`${adapterLabel} provider.keyFile must not be empty`);
    return value;
  } finally {
    await handle.close();
  }
};

export const startProviderProxy = async ({
  provider, keyFile, keyMaterial, tokenFile, socketPath, isolatedPort, adapterLabel = 'OpenCode',
  // When set, every completion must request this model and be served by it.
  pinnedModel,
}) => {
  if (pinnedModel !== undefined && (typeof pinnedModel !== 'string' || !pinnedModel.trim())) {
    throw new Error(`${adapterLabel} pinnedModel must be a non-empty string`);
  }
  const modelState = { requested: new Set(), served: new Set(), refused: 0, failures: [] };
  const upstream = new URL(provider.baseURL);
  if (socketPath && (!isAbsolute(socketPath)
    || !Number.isInteger(isolatedPort) || isolatedPort < 1 || isolatedPort > 65535)) {
    throw new Error(`${adapterLabel} isolated proxy requires an absolute socket path and valid port`);
  }
  if (!['http:', 'https:'].includes(upstream.protocol)
    || upstream.username || upstream.password || upstream.search || upstream.hash) {
    throw new Error(`${adapterLabel} provider.baseURL must be an http(s) URL without embedded credentials or query data`);
  }
  const basePath = upstream.pathname.replace(/\/+$/, '') || '/';
  const upstreamKey = keyMaterial === undefined ? await readProviderKey(keyFile, adapterLabel) : keyMaterial;
  if (typeof upstreamKey !== 'string' || !upstreamKey || /[\r\n]/.test(upstreamKey)) throw new Error('Invalid provider key');
  const proxyToken = randomBytes(32).toString('base64url');
  await writeFile(tokenFile, proxyToken, { encoding: 'utf8', mode: 0o600 });
  await chmod(tokenFile, 0o600);

  const logRefusedRequest = (method, requestPath) => {
    let normalizedPath = '/';
    try {
      normalizedPath = new URL(requestPath || '/', 'http://127.0.0.1').pathname || '/';
    } catch {
      // Do not include an unparseable raw request target in logs.
    }
    const safeMethod = typeof method === 'string' && /^[A-Z]+$/.test(method)
      ? method : 'UNKNOWN';
    process.stderr.write(`[${adapterLabel.toLowerCase()}] provider proxy refused ${safeMethod} ${normalizedPath}\n`);
  };

  const server = createServer((incoming, outgoing) => {
    const supplied = Buffer.from(incoming.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${proxyToken}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      incoming.resume();
      outgoing.writeHead(401).end();
      return;
    }
    if (!['GET', 'POST'].includes(incoming.method || '')) {
      incoming.resume();
      outgoing.writeHead(405).end();
      return;
    }
    const rejectRoute = (path) => {
      logRefusedRequest(incoming.method, path);
      incoming.resume();
      outgoing.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      outgoing.end(`Unsupported provider request: ${incoming.method || 'UNKNOWN'} ${path}`);
    };
    const rejectBadRequest = () => {
      logRefusedRequest(incoming.method, incoming.url);
      incoming.resume();
      outgoing.writeHead(400).end();
    };

    let target;
    try {
      const requestPath = incoming.url || '/';
      if (!requestPath.startsWith('/') || requestPath.startsWith('//')) {
        rejectBadRequest();
        return;
      }
      if (/%(?:2f|5c|2e)/i.test(requestPath)) {
        rejectBadRequest();
        return;
      }
      // The CLI owns this local request path, so never use it as an outbound
      // URL. The OpenAI-compatible chat provider needs only these fixed routes;
      // parse the incoming URL against a loopback sentinel, then select a
      // constant endpoint after matching the configured base path exactly.
      // This keeps a CLI request from turning the proxy into an arbitrary
      // path/URL fetcher (including paths on a local provider host).
      const requested = new URL(requestPath, 'http://127.0.0.1');
      if (requested.origin !== 'http://127.0.0.1' || requested.search || requested.hash) {
        rejectRoute(requested.pathname);
        return;
      }
      const configuredPath = basePath === '/' ? '' : basePath;
      let endpoint;
      if (incoming.method === 'POST'
        && requested.pathname === `${configuredPath}/chat/completions`) {
        endpoint = 'chat/completions';
      } else if (incoming.method === 'GET'
        && requested.pathname === `${configuredPath}/models`) {
        endpoint = 'models';
      } else {
        rejectRoute(requested.pathname);
        return;
      }
      target = {
        path: `${configuredPath}/${endpoint}`,
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || undefined,
        host: upstream.host,
      };
    } catch {
      rejectBadRequest();
      return;
    }

    const headers = Object.fromEntries(Object.entries(incoming.headers)
      .filter(([name]) => ![
        'authorization', 'connection', 'host', 'keep-alive', 'proxy-authenticate',
        'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
        'x-api-key',
      ].includes(name.toLowerCase())));
    headers.authorization = `Bearer ${upstreamKey}`;
    headers.host = target.host;
    headers['accept-encoding'] = 'identity';
    const pinned = pinnedModel !== undefined && target.path.endsWith('/chat/completions');
    const forward = (body) => {
      let streamed = false;
      if (body) {
        headers['content-length'] = String(body.length);
        try { streamed = JSON.parse(body.toString('utf8'))?.stream === true; } catch { /* checked before forward */ }
      }
      const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: target.path,
        method: incoming.method,
        headers,
      }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400) {
          response.resume();
          outgoing.writeHead(502).end('Provider redirects are not supported');
          return;
        }
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
          response.resume(); outgoing.writeHead(502).end('Compressed provider responses are not supported'); return;
        }
        const responseHeaders = Object.fromEntries(Object.entries(response.headers)
          .filter(([name]) => ![
            'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
            'te', 'trailer', 'transfer-encoding', 'upgrade',
          ].includes(name.toLowerCase())));
        delete responseHeaders['content-length'];
        for (const [name, value] of Object.entries(responseHeaders)) {
          if (typeof value === 'string') responseHeaders[name] = value.split(upstreamKey).join('[redacted]');
          else if (Array.isArray(value)) responseHeaders[name] = value.map((entry) => entry.split(upstreamKey).join('[redacted]'));
        }
        const ok = response.statusCode >= 200 && response.statusCode < 300;
        if (!pinned || !ok) {
          outgoing.writeHead(response.statusCode || 502, responseHeaders);
          response.pipe(redactProviderMaterial(upstreamKey)).pipe(outgoing);
          return;
        }
        const sse = streamed || /text\/event-stream/i.test(String(response.headers['content-type'] || ''));
        const check = servedModelCheck({
          pinned: pinnedModel, stream: sse, onServed: (served) => modelState.served.add(served),
        });
        const fail = (error) => {
          modelState.failures.push(error.message);
          process.stderr.write(`[${adapterLabel.toLowerCase()}] provider proxy: ${error.message}\n`);
          response.destroy();
          if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end('Served model check failed');
          else outgoing.destroy();
        };
        check.on('error', fail);
        // A stream's headers go out at once; a whole body waits for its check.
        if (sse) outgoing.writeHead(response.statusCode, responseHeaders);
        else check.once('data', () => { if (!outgoing.headersSent) outgoing.writeHead(response.statusCode, responseHeaders); });
        response.pipe(check).pipe(redactProviderMaterial(upstreamKey)).pipe(outgoing);
      });
      request.on('error', () => {
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end('Provider request failed');
      });
      outgoing.on('close', () => request.destroy());
      incoming.on('aborted', () => request.destroy());
      if (body) request.end(body);
      else incoming.pipe(request);
    };
    if (!pinned) {
      forward(null);
      return;
    }
    // A pinned proxy reads the request first: a completion for any other model
    // is refused here, before the provider bills it.
    const chunks = [];
    let size = 0;
    incoming.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_PINNED_REQUEST_BYTES) chunks.push(chunk);
    });
    incoming.on('end', () => {
      if (size > MAX_PINNED_REQUEST_BYTES) { outgoing.writeHead(413).end(); return; }
      const body = Buffer.concat(chunks);
      let requested;
      try { requested = JSON.parse(body.toString('utf8'))?.model; } catch { requested = undefined; }
      if (requested !== pinnedModel) {
        modelState.refused += 1;
        process.stderr.write(`[${adapterLabel.toLowerCase()}] provider proxy refused a completion for an unpinned model\n`);
        outgoing.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        outgoing.end(`This seat is pinned to ${pinnedModel}`);
        return;
      }
      modelState.requested.add(requested);
      forward(body);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    const started = () => {
      server.removeListener('error', reject);
      resolve();
    };
    if (socketPath) server.listen(socketPath, started);
    else server.listen(0, '127.0.0.1', started);
  });
  if (socketPath) {
    try {
      await chmod(socketPath, 0o600);
    } catch (err) {
      await new Promise((resolve) => server.close(resolve));
      throw err;
    }
  }
  const port = socketPath ? isolatedPort : server.address().port;
  const proxyBaseURL = new URL(upstream.pathname, `http://127.0.0.1:${port}`).toString();
  return {
    baseURL: proxyBaseURL,
    tokenFile,
    socketPath,
    port,
    /** The pin's verdict so far: what was asked for, what was served, and what failed. */
    modelCheck: () => ({
      pinned: pinnedModel ?? null,
      requested: [...modelState.requested],
      served: [...modelState.served],
      refused: modelState.refused,
      failures: [...modelState.failures],
    }),
    close: () => new Promise((resolve) => {
      server.close(async () => {
        if (socketPath) await unlink(socketPath).catch(() => {});
        resolve();
      });
      server.closeAllConnections?.();
    }),
  };
};

