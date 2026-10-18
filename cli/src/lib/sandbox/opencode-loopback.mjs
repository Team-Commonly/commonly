/**
 * Runs inside OpenCode's private bwrap network namespace. The only route to
 * the host is through the two fixed-origin Unix sockets bound for this spawn.
 */
import { spawn, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { createServer, connect } from 'net';

const [socketPath, portText, instanceSocketPath, instancePortText, binary, ...args] = process.argv.slice(2);
const port = Number(portText);
const instancePort = Number(instancePortText);
if (!socketPath || !instanceSocketPath || !binary
  || !Number.isInteger(port) || port < 1 || port > 65535
  || !Number.isInteger(instancePort) || instancePort < 1 || instancePort > 65535
  || port === instancePort) {
  throw new Error('OpenCode loopback bridge requires distinct provider and instance ports');
}

const ip = ['/usr/sbin/ip', '/sbin/ip', '/usr/bin/ip', '/bin/ip'].find(existsSync);
if (!ip) throw new Error('OpenCode isolated loopback requires iproute2');
const up = spawnSync(ip, ['link', 'set', 'lo', 'up'], { encoding: 'utf8' });
if (up.error || up.status !== 0) {
  throw new Error(`OpenCode isolated loopback could not start: ${up.error?.message || up.stderr?.trim() || up.status}`);
}
const setpriv = ['/usr/bin/setpriv', '/bin/setpriv'].find(existsSync);
if (!setpriv) throw new Error('OpenCode isolated loopback requires setpriv');

const sockets = new Set();
const makeBridge = (path) => createServer((local) => {
  const proxy = connect(path);
  sockets.add(local);
  sockets.add(proxy);
  local.on('close', () => sockets.delete(local));
  proxy.on('close', () => sockets.delete(proxy));
  local.on('error', () => proxy.destroy());
  proxy.on('error', () => local.destroy());
  local.pipe(proxy).pipe(local);
});
const providerBridge = makeBridge(socketPath);
const instanceBridge = instanceSocketPath === '-' ? null : makeBridge(instanceSocketPath);
providerBridge.on('error', (err) => { throw err; });
instanceBridge?.on('error', (err) => { throw err; });
providerBridge.listen(port, '127.0.0.1', () => {
  const startChild = () => {
    // Only this bridge needs CAP_NET_ADMIN to raise lo and CAP_SETPCAP to drop
    // both capabilities before starting the model process.
    const child = spawn(setpriv, [
      '--bounding-set=-net_admin,-setpcap',
      '--inh-caps=-net_admin,-setpcap',
      '--ambient-caps=-net_admin,-setpcap',
      binary, ...args,
    ], { stdio: 'inherit', env: process.env });
    const forward = (signal) => { if (!child.killed) child.kill(signal); };
    process.on('SIGTERM', () => forward('SIGTERM'));
    process.on('SIGINT', () => forward('SIGINT'));
    child.on('error', (err) => {
      process.stderr.write(`${err.message}\n`);
    });
    child.on('close', (code, signal) => {
      for (const socket of sockets) socket.destroy();
      providerBridge.close();
      if (instanceBridge) instanceBridge.close(() => { process.exitCode = code ?? (signal === 'SIGTERM' ? 143 : 1); });
      else process.exitCode = code ?? (signal === 'SIGTERM' ? 143 : 1);
    });
  };
  if (instanceBridge) instanceBridge.listen(instancePort, '127.0.0.1', startChild);
  else startChild();
});
