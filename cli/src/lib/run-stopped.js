import { resolveInstanceUrl } from './config.js';

// F549: a first `agent run` with no key in its environment (the two
// `$env:` lines pasted into Command Prompt, or skipped) exits before any
// server call, so the connect page waits on a key that never arrives and
// nobody can tell this stop from a line that never ran. This tells the
// server which stop it was. It carries no key: only a fixed reason, the
// agent's name (the server matches it to a BYO agent made in the last day),
// the platform and Node's major version. DO_NOT_TRACK=1 or
// COMMONLY_TELEMETRY=0 turns it off. It never throws and gives up after
// `timeoutMs`, so the exit it precedes is never held up for long.
export const reportRunStopped = async ({
  agentName,
  reason,
  env = process.env,
  platform = process.platform,
  nodeVersion = process.version,
  fetchImpl = globalThis.fetch,
  defaultUrl = () => resolveInstanceUrl(undefined),
  timeoutMs = 2000,
}) => {
  if (env.DO_NOT_TRACK === '1' || env.COMMONLY_TELEMETRY === '0') return false;
  if (typeof fetchImpl !== 'function') return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const base = ((env.COMMONLY_API_URL || '').trim() || defaultUrl()).replace(/\/+$/, '');
    const nodeMajor = Number.parseInt(String(nodeVersion).replace(/^v/, ''), 10);
    const res = await fetchImpl(`${base}/api/stats/run-stopped`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reason, agentName, platform, ...(Number.isFinite(nodeMajor) ? { nodeMajor } : {}),
      }),
      signal: controller.signal,
    });
    return Boolean(res?.ok);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};
