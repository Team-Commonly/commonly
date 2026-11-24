/**
 * A process that may serve only while it shares Redis with its siblings.
 *
 * With two backend processes behind one load balancer, the socket.io Redis
 * adapter and the process bus (services/processBus.ts) are what make the
 * second one correct: a pod-room emit, a session or agent-token revocation and
 * a cache invalidation reach the sockets and caches it holds only through
 * them. Without Redis that process is a split brain: it serves its own sockets
 * stale and keeps revoked ones connected.
 *
 * So a process started with REQUIRE_SHARED_REDIS=1 stops serving the moment it
 * loses Redis, at boot or at any time later: it drops its sockets (their
 * clients reconnect through the load balancer to a process that is still
 * whole) and shuts itself down through the normal SIGTERM drain
 * (hostedShutdownService). Its supervisor restarts it; a restart that cannot
 * reach Redis stops again. The load balancer meanwhile sends everything to the
 * process that does not require Redis, which alone is a correct single-process
 * backend.
 *
 * Only the extra process sets it. The primary keeps serving through a Redis
 * outage (its adapter and bus fall back to local delivery), because a Redis
 * blip must never take the whole API down.
 */

type LostHook = () => void;

const hooks: LostHook[] = [];
let stopped = false;

export const sharedRedisRequired = (env: NodeJS.ProcessEnv = process.env): boolean => (
  env.REQUIRE_SHARED_REDIS === '1'
);

/** Runs before the shutdown, e.g. to drop this process's sockets. */
export const onSharedRedisLost = (hook: LostHook): void => {
  hooks.push(hook);
};

/**
 * Called by every shared-Redis client on a connect failure, an `error` or an
 * `end`. A no-op unless this process requires shared Redis; then it stops
 * serving, once.
 */
export const sharedRedisLost = (
  source: string,
  error?: unknown,
  { env = process.env, kill = (pid: number, signal: NodeJS.Signals) => { process.kill(pid, signal); } }:
  { env?: NodeJS.ProcessEnv; kill?: (pid: number, signal: NodeJS.Signals) => void } = {},
): boolean => {
  if (!sharedRedisRequired(env) || stopped) return false;
  stopped = true;
  const message = (error as { message?: string } | undefined)?.message || String(error ?? 'connection ended');
  console.error(`[shared-redis] ${source} lost Redis (${message}). REQUIRE_SHARED_REDIS=1: this process stops serving.`);
  for (const hook of hooks) {
    try {
      hook();
    } catch (hookError) {
      console.error('[shared-redis] a lost-Redis hook failed:', (hookError as Error)?.message || hookError);
    }
  }
  kill(process.pid, 'SIGTERM');
  return true;
};

/** Tests only. */
export const resetSharedRedisRequiredForTests = (): void => {
  hooks.length = 0;
  stopped = false;
};
