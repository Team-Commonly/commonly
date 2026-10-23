/**
 * Per-spawn GitHub command bridge for a confined host seat. The socket carries
 * no secret: its trusted owner holds the runtime token and chooses the backend
 * URL. The Codex permission profile must allow only this seat's exact socket.
 */
import { createServer } from 'net';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { join } from 'path';

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024;
const SHIM_SOURCE = fileURLToPath(new URL('./host-gh-shim.mjs', import.meta.url));

const reply = (socket, status, body) => {
  if (!socket.destroyed) socket.end(JSON.stringify({ status, body }));
};

export const startSeatGhBroker = async ({
  runtimeToken, instanceUrl, fetchImpl = fetch, root = join(homedir(), '.commonly', 'host-gh'),
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
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error('host GitHub broker root must be a real directory');
  }
  await chmod(root, 0o700);
  const directory = await mkdtemp(join(root, 'seat-'));
  const socketPath = join(directory, 'broker.sock');
  const shimPath = join(directory, 'gh');
  let server;
  try {
    const shimSource = await readFile(SHIM_SOURCE, 'utf8');
    await writeFile(shimPath, `#!${process.execPath}\n${shimSource.replace(/^#![^\n]*\n/, '')}`, { mode: 0o500 });
    await chmod(shimPath, 0o555);
    server = createServer({ allowHalfOpen: true }, (socket) => {
      let chunks = [];
      let size = 0;
      socket.setTimeout(15_000, () => socket.destroy());
      socket.on('error', () => {});
      socket.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) {
          reply(socket, 413, { error: 'request_too_large' });
          chunks = [];
        } else {
          chunks.push(chunk);
        }
      });
      socket.on('end', async () => {
        if (socket.destroyed || size > MAX_REQUEST_BYTES) return;
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
        try {
          const url = new URL(`/api/mcp/grants/${encodeURIComponent(grantId)}/cli`, endpoint);
          const response = await fetchImpl(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${runtimeToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ operation, args }),
            signal: AbortSignal.timeout(15_000),
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
      directory,
      async close() {
        await new Promise((resolve) => server.close(resolve));
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
};
