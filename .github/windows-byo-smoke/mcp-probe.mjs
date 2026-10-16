// Starts the commonly MCP server the way Claude Code would on Windows
// (`cmd /c npx -y @commonlyai/mcp`), sends `initialize`, and prints every byte
// it says on stdout and stderr, plus how it ended. Fake token: nothing real.
import { spawn } from 'node:child_process';

const [command, ...args] = process.argv.slice(2);
const started = Date.now();
const stamp = () => `+${((Date.now() - started) / 1000).toFixed(1)}s`;
const child = spawn(command, args, {
  env: { ...process.env, COMMONLY_API_URL: 'https://api.commonly.me', COMMONLY_AGENT_TOKEN: 'cm_agent_windows_smoke_not_a_real_token' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.on('error', (err) => console.log(stamp(), 'spawn error:', err.code || err.message));
child.stdout.on('data', (d) => console.log(stamp(), 'stdout:', String(d).slice(0, 800)));
child.stderr.on('data', (d) => console.log(stamp(), 'stderr:', String(d).slice(0, 800)));
child.on('exit', (code, signal) => { console.log(stamp(), 'exited', code, signal || ''); process.exit(0); });
setTimeout(() => {
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0' } },
  })}\n`);
}, 1000);
setTimeout(() => { console.log(stamp(), 'still running at 90s; stopping'); child.kill(); process.exit(0); }, 90000);
