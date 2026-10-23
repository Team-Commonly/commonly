/**
 * Per-spawn GitHub command bridge for a confined host seat. The socket carries
 * no secret: its trusted owner holds the runtime token and chooses the backend
 * URL. The Codex permission profile must allow only this seat's exact socket.
 */
import { createServer } from 'net';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { join, resolve } from 'path';

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024;
const SHIM_SOURCE = fileURLToPath(new URL('./host-gh-shim.mjs', import.meta.url));
const PUSH_HELPER_SOURCE = fileURLToPath(new URL('./git-remote-commonly.mjs', import.meta.url));
const MAX_PUSH_REQUEST_BYTES = 9 * 1024 * 1024;

const reply = (socket, status, body) => {
  if (!socket.destroyed) socket.end(JSON.stringify({ status, body }));
};

export const startSeatGhBroker = async ({
  runtimeToken, instanceUrl, shimRoot, fetchImpl = fetch,
  root = join(homedir(), '.commonly', 'host-gh'),
}) => {
  if (typeof runtimeToken !== 'string' || !runtimeToken.startsWith('cm_agent_')) {
    throw new Error('host GitHub broker requires a runtime token');
  }
  const endpoint = new URL(instanceUrl);
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error('host GitHub broker requires an HTTP instance URL');
  }
  if (endpoint.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) {
    throw new Error('host GitHub broker requires HTTPS outside localhost');
  }
  if (typeof shimRoot !== 'string' || !shimRoot) {
    throw new Error('host GitHub broker requires a seat-visible shim root');
  }
  if (resolve(shimRoot) === resolve(root)) {
    throw new Error('host GitHub shims cannot share the protected socket root');
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error('host GitHub broker root must be a real directory');
  }
  await chmod(root, 0o700);
  const shimRootStats = await lstat(shimRoot);
  if (!shimRootStats.isDirectory() || shimRootStats.isSymbolicLink()) {
    throw new Error('host GitHub shim root must be a real directory');
  }
  let socketDirectory;
  let directory;
  let server;
  const connections = new Set();
  try {
    socketDirectory = await mkdtemp(join(root, 'seat-'));
    directory = await mkdtemp(join(shimRoot, '.commonly-gh-'));
    const socketPath = join(socketDirectory, 'broker.sock');
    const shimPath = join(directory, 'gh');
    const pushHelperPath = join(directory, 'git-remote-commonly');
    const shimSource = await readFile(SHIM_SOURCE, 'utf8');
    await writeFile(shimPath, `#!${process.execPath}\n${shimSource.replace(/^#![^\n]*\n/, '')}`, { mode: 0o500 });
    await chmod(shimPath, 0o555);
    const helperSource = await readFile(PUSH_HELPER_SOURCE, 'utf8');
    await writeFile(pushHelperPath, `#!${process.execPath}\n${helperSource.replace(/^#![^\n]*\n/, '')}`, { mode: 0o500 });
    await chmod(pushHelperPath, 0o555);
    server = createServer({ allowHalfOpen: true }, (socket) => {
      connections.add(socket);
      socket.on('close', () => connections.delete(socket));
      let chunks = [];
      let size = 0;
      socket.setTimeout(15_000, () => socket.destroy());
      socket.on('error', () => {});
      socket.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_PUSH_REQUEST_BYTES) {
          reply(socket, 413, { error: 'request_too_large' });
          chunks = [];
        } else {
          chunks.push(chunk);
        }
      });
      socket.on('end', async () => {
        if (socket.destroyed || size > MAX_PUSH_REQUEST_BYTES) return;
        let request;
        try { request = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
          reply(socket, 400, { error: 'invalid_request' });
          return;
        }
        const { grantId, operation, args } = request || {};
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(grantId)
          || typeof operation !== 'string' || !args || typeof args !== 'object'
          || Array.isArray(args) || Object.keys(request).some((key) => !['grantId', 'operation', 'args'].includes(key))) {
          reply(socket, 400, { error: 'invalid_request' });
          return;
        }
        if (operation !== 'push.branch' && size > MAX_REQUEST_BYTES) {
          reply(socket, 413, { error: 'request_too_large' });
          return;
        }
        if (operation === 'push.branch') socket.setTimeout(180_000, () => socket.destroy());
        try {
          const suffix = operation === 'push.branch' ? 'push' : 'cli';
          const url = new URL(`/api/mcp/grants/${encodeURIComponent(grantId)}/${suffix}`, endpoint);
          const response = await fetchImpl(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${runtimeToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(operation === 'push.branch' ? args : { operation, args }),
            signal: AbortSignal.timeout(operation === 'push.branch' ? 180_000 : 15_000),
          });
          const bodyText = await response.text();
          if (Buffer.byteLength(bodyText, 'utf8') > MAX_RESPONSE_BYTES) {
            reply(socket, 502, { error: 'broker_response_too_large' });
            return;
          }
          let body;
          try { body = JSON.parse(bodyText); } catch { body = { error: 'broker_response_invalid' }; }
          reply(socket, response.status, body);
        } catch {
          reply(socket, 502, { error: 'broker_unavailable' });
        }
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    return {
      socketPath,
      shimPath,
      pushHelperPath,
      directory,
      socketDirectory,
      async close() {
        for (const socket of connections) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
        await rm(directory, { recursive: true, force: true });
        await rm(socketDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    for (const socket of connections) socket.destroy();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    if (directory) await rm(directory, { recursive: true, force: true });
    if (socketDirectory) await rm(socketDirectory, { recursive: true, force: true });
    throw error;
  }
};
