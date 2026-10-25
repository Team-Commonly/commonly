/**
 * Put one run inside the OS sandbox. prepareRunEnv decides what the run
 * holds (its env, a throwaway HOME, the granted credentials); this decides
 * what it can reach beyond that. It composes the Seatbelt and bwrap builders
 * in ../sandbox/ rather than writing a profile of its own, so the cli's
 * public seats and a valet run share one policy text.
 *
 *   macOS  Seatbelt: deny by default. Writes land only in the run's HOME
 *          (TMPDIR is inside it). The real HOME's login paths are denied by
 *          absolute path, after every allow, so even a workspace that holds
 *          them cannot open them. securityd's mach services are dropped and
 *          denied: the run's credentials are in its env, so nothing in it has
 *          a reason to ask the keychain.
 *   Linux  bwrap: only the run's HOME (and a workspace, if one is given) is
 *          bound; the real HOME is never mounted.
 *   other  no sandbox. That is a named result, never a quiet fallback: the
 *          caller gets RunFailure('unsupported') unless it passed
 *          require: false, and then { sandbox: 'none', egress: 'none', reason }.
 *
 * Egress is fenced on both, by the grant's network.allow plus the provider.
 * startRunEgress starts an egress-proxy.js CONNECT proxy in this process;
 * sandboxRunArgv then admits only the route to it and returns the env that
 * names it, together, from the one egress handle:
 *   macOS  the baseline's unfiltered network-outbound allow is dropped; the
 *          profile admits loopback TCP to the proxy's port (and to a loopback
 *          provider's port) and denies direct DNS. HTTPS_PROXY and friends
 *          point at the proxy; NO_PROXY names only a loopback provider.
 *   Linux  bwrap --unshare-net, so the namespace has only its own loopback.
 *          loopback-bridge.mjs, the bridge the cli's OpenCode seat uses,
 *          raises it and forwards one port to the proxy's Unix socket (and
 *          a loopback provider's port to a fixed relay). Argv-tested only:
 *          not walked on a Linux host.
 * A client that ignores the proxy variables has no other route, so it fails
 * closed. Spawn the returned argv with the returned env, never run.env.
 */
import { realpathSync } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { detectSeatbelt, wrapArgvWithSeatbelt } from '../sandbox/seatbelt.js';
import { detectBwrap, wrapArgvWithBwrap } from '../sandbox/bwrap.js';
import { LOOPBACK_BRIDGE } from '../sandbox/loopback.js';
import { traceOf } from '../trace/events.js';
import { runFailure } from '../failures.js';
import { isInside } from './env.js';
import { matchEgress, normalizeHost, parseEgressEntry } from './grant.js';
import { startEgressProxy, startLoopbackRelay } from './egress-proxy.js';

/**
 * Where a CLI keeps the user's login, relative to a real HOME. Seatbelt denies
 * each one even when a broader allow covers it.
 */
export const REAL_HOME_LOGIN_PATHS = Object.freeze([
  '.claude', '.claude.json', '.codex', '.commonly', '.config', '.ssh', '.aws',
  '.gnupg', '.netrc', '.npmrc', '.docker', '.kube',
  'Library/Keychains', 'Library/Application Support', 'Library/Cookies',
]);

// Seatbelt matches resolved paths (/var is /private/var), so compare those.
const real = (path) => {
  try { return realpathSync(path); } catch { return path; }
};

const checkPlacement = ({ run, workspace, realHomes, loginPaths, platform }) => {
  const home = real(run.home);
  for (const realHome of realHomes) {
    if (isInside(realHome, home)) throw new Error('sandboxRunArgv: the run HOME holds the real HOME');
  }
  if (loginPaths.some((path) => isInside(home, path))) {
    throw new Error('sandboxRunArgv: the run HOME is inside a login path the sandbox denies');
  }
  if (!workspace) return;
  const ws = real(workspace.path);
  if (loginPaths.some((path) => isInside(ws, path))) {
    throw new Error('sandboxRunArgv: the workspace is inside a login path the sandbox denies');
  }
  // bwrap can only leave a path unmounted, not punch a hole in a mount, so a
  // workspace holding the real HOME would mount its login with it.
  if (platform === 'linux' && realHomes.some((realHome) => isInside(realHome, ws))) {
    throw new Error('sandboxRunArgv: on Linux the workspace may not hold the real HOME');
  }
};

const EGRESS = Symbol('run egress');
// Ports the bridge listens on inside a bwrap namespace, the same pair the
// cli's OpenCode seat uses. They need not be free on the host.
const INNER_PROXY_PORTS = [8765, 8766];

const isLoopbackHost = (host) => host === 'localhost' || host.endsWith('.localhost')
  || (isIP(host) === 4 && host.startsWith('127.')) || host === '::1';

/** provider.baseURL → { host, port, loopback }. */
const parseProvider = (provider) => {
  let url;
  try { url = new URL(String(provider?.baseURL)); } catch { throw new Error('startRunEgress: provider.baseURL must be a URL'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('startRunEgress: provider.baseURL must be http or https');
  const host = normalizeHost(url.hostname.replace(/^\[|\]$/g, ''));
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  if (isLoopbackHost(host)) return { host, port, loopback: true };
  if (isIP(host)) throw new Error('startRunEgress: provider.baseURL names an IP address; name the host');
  return { host, port, loopback: false };
};

/**
 * startRunEgress({ run, provider?, platform?, trace?, ctx?, idleMs?, lookup? })
 *   → Promise<egress handle> with { platform, port, socketPath, close() }
 *
 * Starts the proxy that fences `run` (prepareRunEnv's result): its grant's
 * network.allow plus `provider: { baseURL }`, added as one exact host:port.
 * A loopback provider (localhost, 127.x, ::1) is not proxied: it is reached
 * directly, and the sandbox admits its one port. Run credentials are redacted
 * from egress trace hosts. Pass the handle to sandboxRunArgv, and close() it
 * once the run's process has exited. Off macOS and Linux nothing is started;
 * sandboxRunArgv decides what that means.
 */
export const startRunEgress = async ({
  run, provider, platform = process.platform, trace, ctx, idleMs, lookup,
} = {}) => {
  if (!run || !run.network || !Array.isArray(run.network.allow)) {
    throw new Error("startRunEgress: run must be prepareRunEnv's result");
  }
  const hook = trace && typeof trace.emit === 'function' ? trace : traceOf(ctx);
  const allow = [...run.network.allow];
  let direct = null;
  if (provider !== undefined && provider !== null) {
    const parsed = parseProvider(provider);
    if (parsed.loopback) direct = { host: parsed.host, port: parsed.port };
    else if (!matchEgress(allow, parsed.host, parsed.port)?.exact) allow.push(parseEgressEntry(`${parsed.host}:${parsed.port}`, 'provider.baseURL'));
  }
  const redact = (run.granted || []).map((name) => run.env?.[name]).filter(Boolean);
  const options = { allow, trace: hook, idleMs, redact, ...(lookup ? { lookup } : {}) };
  const handle = (fields, close) => Object.freeze({
    [EGRESS]: run, platform, port: null, socketPath: null, direct, allow: allow.map((rule) => rule.entry), ...fields, close,
  });

  if (platform === 'darwin') {
    const proxy = await startEgressProxy(options);
    return handle({ port: proxy.port }, proxy.close);
  }
  if (platform === 'linux') {
    // A fresh 0700 directory: the namespace mounts it read-only, and the
    // socket path stays short (sun_path is ~108 bytes).
    const dir = await mkdtemp(join(tmpdir(), 'seat-egress-'));
    await chmod(dir, 0o700);
    const opened = [];
    const close = async () => {
      for (const server of opened.splice(0)) await server.close();
      await rm(dir, { recursive: true, force: true });
    };
    try {
      opened.push(await startEgressProxy({ ...options, socketPath: join(dir, 'egress.sock') }));
      if (direct) opened.push(await startLoopbackRelay({ socketPath: join(dir, 'provider.sock'), ...direct, idleMs }));
    } catch (error) {
      await close();
      throw error;
    }
    return handle({ socketDir: dir, socketPath: opened[0].socketPath, relaySocketPath: opened[1]?.socketPath ?? null }, close);
  }
  return handle({}, async () => {});
};

/** The env a proxied run spawns with: its own, plus the route out. */
const proxiedEnv = (run, proxyUrl, direct) => {
  const env = { ...run.env };
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']) env[name] = proxyUrl;
  // Node 24+ reads the proxy variables only when asked to.
  env.NODE_USE_ENV_PROXY = '1';
  if (direct) {
    env.NO_PROXY = direct.host;
    env.no_proxy = direct.host;
  }
  return env;
};

/**
 * sandboxRunArgv({ argv, run, egress, platform?, workspace?, require?, trace?, ctx?, detect? })
 *   → { argv, env, sandbox: 'seatbelt'|'bwrap'|'none', egress: 'proxy'|'none', reason? }
 *
 * `argv[0]` is the CLI by absolute path (prepareRunEnv drops PATH entries
 * under the real HOME, so a bare name is not a reliable lookup). `run` is
 * prepareRunEnv's result and `egress` is startRunEgress's result for that
 * same run. Spawn the returned argv with the returned env (never run.env),
 * with cwd at run.home or the workspace. The network rules and the proxy
 * variables come out of this one call together, or not at all: with no
 * sandbox the env carries no proxy variables either. `workspace` is
 * { path, access: 'read'|'write' }, read when access is left out. `require`
 * defaults to true.
 *
 * Emits sandbox.applied { sandbox, reason? } on `trace`, else ctx.trace.
 */
export const sandboxRunArgv = ({
  argv, run, egress, platform = process.platform, workspace, require: required = true, trace, ctx, detect = {},
} = {}) => {
  if (!Array.isArray(argv) || argv.length === 0 || !isAbsolute(String(argv[0]))) {
    throw new Error('sandboxRunArgv: argv[0] must be the CLI by absolute path');
  }
  if (!run || typeof run.home !== 'string' || !isAbsolute(run.home)) {
    throw new Error("sandboxRunArgv: run must be prepareRunEnv's result");
  }
  if (!egress || egress[EGRESS] !== run) {
    throw new Error("sandboxRunArgv: egress must be startRunEgress's result for this run");
  }
  if (egress.platform !== platform) throw new Error('sandboxRunArgv: egress was started for another platform');
  if (workspace && (typeof workspace.path !== 'string' || !isAbsolute(workspace.path))) {
    throw new Error('sandboxRunArgv: workspace.path must be absolute');
  }
  const ws = workspace ? { path: workspace.path, access: workspace.access ?? 'read' } : null;
  const realHomes = [...new Set((run.realHomes?.length ? run.realHomes : [homedir()]).map(real))];
  const loginPaths = realHomes.flatMap((home) => REAL_HOME_LOGIN_PATHS.map((path) => join(home, path)));
  checkPlacement({ run, workspace: ws, realHomes, loginPaths, platform });

  const hook = trace && typeof trace.emit === 'function' ? trace : traceOf(ctx);
  const applied = (sandbox, wrapped, env, reason) => {
    hook.emit('sandbox.applied', reason ? { sandbox, reason } : { sandbox });
    const result = { argv: wrapped, env, sandbox, egress: sandbox === 'none' ? 'none' : 'proxy' };
    return reason ? { ...result, reason } : result;
  };
  const unsandboxed = (reason) => {
    if (required) throw runFailure('unsupported', `no OS sandbox for this run: ${reason}`);
    return applied('none', [...argv], { ...run.env }, reason);
  };
  const { direct } = egress;

  if (platform === 'darwin') {
    const found = (detect.seatbelt || detectSeatbelt)();
    if (!found.available) return unsandboxed(found.error);
    return applied('seatbelt', wrapArgvWithSeatbelt(argv, {
      workspacePath: ws ? ws.path : run.home,
      workspaceAccess: ws ? ws.access : 'write',
      executablePath: argv[0],
      statePath: run.home,
      allowKeychainServices: false,
      denyPaths: loginPaths,
      allowNetworkOutbound: false,
      denyDns: true,
      loopbackNetworkPorts: direct ? [egress.port, direct.port] : [egress.port],
    }), proxiedEnv(run, `http://127.0.0.1:${egress.port}`, direct));
  }
  if (platform === 'linux') {
    const found = (detect.bwrap || detectBwrap)({ platform });
    if (!found.available) return unsandboxed(found.error);
    const [proxyPort, spare] = direct?.port === INNER_PROXY_PORTS[0] ? [...INNER_PROXY_PORTS].reverse() : INNER_PROXY_PORTS;
    // The bridge takes two socket:port slots; the second carries a loopback
    // provider, or '-' with an unused port when there is none.
    const bridged = [
      process.execPath, LOOPBACK_BRIDGE,
      egress.socketPath, String(proxyPort),
      direct ? egress.relaySocketPath : '-', String(direct ? direct.port : spare),
      ...argv,
    ];
    return applied('bwrap', wrapArgvWithBwrap(bridged, {
      sandbox: {
        network: { policy: 'restricted' },
        // With a separate workspace, HOME is the extra writable mount.
        filesystem: ws ? { 'write-outside': [run.home] } : {},
      },
    }, {
      workspacePath: ws ? ws.path : run.home,
      workspaceAccess: ws ? ws.access : 'write',
      homePath: run.home,
      // The CLI by absolute path may live outside the default system binds;
      // node and the bridge run first, and the sockets live in socketDir.
      readOnlyPaths: [argv[0], process.execPath, LOOPBACK_BRIDGE, egress.socketDir],
      // iproute2, which the bridge raises lo with.
      optionalReadOnlyPaths: ['/usr/sbin', '/sbin'],
      enableLoopback: true,
    }), proxiedEnv(run, `http://127.0.0.1:${proxyPort}`, direct));
  }
  return unsandboxed(`no supported OS sandbox on ${platform}`);
};
