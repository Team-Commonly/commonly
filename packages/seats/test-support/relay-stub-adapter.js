/**
 * An adapter over relay-stub-cli.mjs, for the provider relay tests. It points
 * the stub CLI at ctx.providerRelay exactly as a real adapter points its CLI,
 * and reports the child through ctx.onSpawn so the supervisor reads its output
 * as liveness.
 *
 *   route: 'bind'        bind the relay and hand the CLI the relay's URL (default)
 *          'ignore'      bind the relay, but the CLI calls the provider directly,
 *                        as a CLI that ignores its base-URL override does
 *          'notCovered'  report the CLI as not pointable
 *          'none'        never touch ctx.providerRelay
 *   trip: true  bind in trip mode, as an ACP adapter does: the first failing
 *               provider answer stops the CLI and the turn rejects with it
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const STUB_CLI = fileURLToPath(new URL('./relay-stub-cli.mjs', import.meta.url));

export const createRelayStubAdapter = ({
  upstream, wire = 'responses', headers = {}, surface = false, route = 'bind', env = {}, trip = false,
} = {}) => ({
  name: 'relay-stub',
  async detect() { return { path: STUB_CLI, version: '0.0.0' }; },
  spawn(prompt, ctx = {}) {
    let baseURL = upstream;
    let child = null;
    let tripped = null;
    const onTrip = trip ? (failure) => { tripped = failure; child?.kill('SIGTERM'); } : null;
    if (route === 'bind' || route === 'ignore') {
      const relayed = ctx.providerRelay?.bind({ upstream, onTrip });
      if (route === 'bind' && relayed) baseURL = relayed;
    } else if (route === 'notCovered') {
      ctx.providerRelay?.notCovered('relay-stub cannot be pointed at a base URL');
    }
    return new Promise((resolve, reject) => {
      child = spawn(process.execPath, [STUB_CLI], {
        env: {
          ...process.env,
          ...env,
          STUB_BASE_URL: baseURL,
          STUB_WIRE: wire,
          STUB_HEADERS: JSON.stringify(headers),
          STUB_PROMPT: prompt,
          STUB_SURFACE: surface ? '1' : '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      ctx.onSpawn?.({ model: null, effort: null }, child);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const onAbort = () => child.kill('SIGTERM');
      ctx.signal?.addEventListener?.('abort', onAbort, { once: true });
      child.on('error', reject);
      child.on('close', (code) => {
        ctx.signal?.removeEventListener?.('abort', onAbort);
        if (ctx.signal?.aborted) { reject(ctx.signal.reason); return; }
        if (tripped) { reject(tripped); return; }
        if (code !== 0) { reject(new Error(`relay-stub exited ${code}: ${stderr.trim().slice(0, 200)}`)); return; }
        resolve({ text: stdout.trim() });
      });
    });
  },
});
