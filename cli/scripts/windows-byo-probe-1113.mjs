#!/usr/bin/env node
/**
 * One-off probe (11-13, never merged): why a Windows visitor who copied the
 * Bring your own page's four PowerShell lines can end with "copied, installed,
 * token never used". Each case runs the page's lines one way a person might,
 * against a local stub API that records which tokens reached it, and reports
 * what the person would see and whether the token was used.
 *
 * Cases (PROBE_CASES=all, or a comma list, or control):
 *   control        the four lines in one Windows PowerShell 5.1 window
 *   cmd-paste      the four lines entered into Command Prompt
 *   split-windows  lines 1-3 in one PowerShell window, line 4 in a new one
 *   no-node        the four lines with no Node or npm on PATH
 *   ui-ctrlv       a real console window: Ctrl+V of the block (no trailing
 *                  newline), then later one Enter
 *   ui-typed       a real console window: the block arrives as keystrokes, as
 *                  a legacy right-click paste does, then later one Enter
 */
import { spawn, spawnSync } from 'child_process';
import http from 'http';
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'fs';
import { join, delimiter } from 'path';
import { tmpdir } from 'os';

if (process.platform !== 'win32' || !process.env.CI) {
  console.error('windows-byo-probe: Windows CI only.');
  process.exit(2);
}

const SHOTS = join(process.env.RUNNER_TEMP || tmpdir(), 'probe-shots');
mkdirSync(SHOTS, { recursive: true });
const log = (line) => console.log(`${new Date().toISOString()} ${line}`);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// ── stub API: records every request and the bearer token it carried ────────
const seen = new Map();
const server = http.createServer((req, res) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || '(none)';
  if (!seen.has(token)) seen.set(token, []);
  seen.get(token).push(`${req.method} ${req.url.split('?')[0]}`);
  res.writeHead(401, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'probe stub: not a real server' }));
});
const port = await new Promise((r) => { server.listen(0, '127.0.0.1', () => r(server.address().port)); });
const API = `http://127.0.0.1:${port}`;

// The page's Windows lines (V2AgentBYO.tsx connectSnippet, os=windows,
// adapter=codex), as mkjlong copied them on 11-12.
const pageLines = (token) => [
  'npm.cmd i -g @commonlyai/cli@latest',
  `$env:COMMONLY_API_URL="${API}"`,
  `$env:COMMONLY_AGENT_TOKEN="${token}"`,
  'commonly.cmd agent run probe-codex --adapter codex --unsandboxed',
];

const cleanEnv = (extra = {}) => {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) if (key.startsWith('COMMONLY_')) delete env[key];
  return env;
};

const killTree = (pid) => spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)]);
const run = (cmd, args, { stdin, env = cleanEnv(), timeoutMs = 4 * 60_000 } = {}) => new Promise((resolve) => {
  const child = spawn(cmd, args, { env, windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const timer = setTimeout(() => { out += '\n[probe: still running at timeout, killed]'; killTree(child.pid); }, timeoutMs);
  child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  if (stdin !== undefined) child.stdin.end(stdin);
  else child.stdin.end();
});
const ps51 = (script, opts) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], opts);
const tokenUse = (token) => (seen.get(token) || []).join(', ') || 'NEVER USED';

// ── UI helpers: a real console window, keys sent to it, screenshots ────────
const psFile = (name, body) => { const p = join(SHOTS, name); writeFileSync(p, body); return p; };
const uiScript = psFile('ui.ps1', `
param([string]$Action, [string]$Arg, [int]$TargetPid)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, Microsoft.VisualBasic
function Focus($id) {
  # Windows 11 hands a new console to Windows Terminal, so the started pid can be gone: fall back to the tab's title.
  try { [Microsoft.VisualBasic.Interaction]::AppActivate($id) | Out-Null } catch {
    $ok = (New-Object -ComObject WScript.Shell).AppActivate('Windows PowerShell'); Write-Output "focus by title: $ok" }
  Start-Sleep -Milliseconds 800
}
switch ($Action) {
  'open'  { $p = Start-Process powershell.exe -ArgumentList '-NoExit','-NoProfile' -PassThru; Start-Sleep 6; Write-Output $p.Id }
  'ctrlv' { Set-Clipboard -Value (Get-Content -Raw $Arg); Focus $TargetPid; [System.Windows.Forms.SendKeys]::SendWait('^v') }
  'type'  { Focus $TargetPid; [System.Windows.Forms.SendKeys]::SendWait((Get-Content -Raw $Arg)) }
  'enter' { Focus $TargetPid; [System.Windows.Forms.SendKeys]::SendWait('~') }
  'shot'  {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save($Arg)
  }
}
`);
// Windows PowerShell 5.1 under -STA, so Set-Clipboard and SendKeys work.
const ui = (action, arg = '', pid = 0) => run('powershell.exe',
  ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', uiScript, '-Action', action, '-Arg', arg, '-TargetPid', String(pid)],
  { timeoutMs: 60_000 });
const sendKeysEscape = (text) => text.replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`).replace(/\r?\n/g, '~');

const uiCase = async (name, mode) => {
  const token = `cm_agent_probe_${name}`;
  // PROBE_TRAIL=1: the text #4052's Windows Copy writes (listenCopyText): the
  // lines joined by \n plus one trailing \n. Otherwise the block as mkjlong
  // copied it, with no trailing newline.
  const block = process.env.PROBE_TRAIL === '1'
    ? `${pageLines(token).join('\n')}\n`
    : pageLines(token).join('\r\n');
  const blockFile = psFile(`${name}.txt`, mode === 'ctrlv' ? block : sendKeysEscape(block));
  const opened = await ui('open');
  const pid = Number(String(opened.out).trim().split(/\s+/).pop());
  if (!pid) return { token, out: `could not open a console window: ${opened.out}` };
  const notes = [];
  const sent = await ui(mode === 'ctrlv' ? 'ctrlv' : 'type', blockFile, pid);
  notes.push(`send ${mode}: exit ${sent.code} ${sent.out.trim().slice(0, 300)}`);
  if (mode === 'ctrlv') {
    // Windows Terminal asks before a multi-line paste; Enter takes the focused
    // "Paste anyway". This Enter goes to the dialog, never to the shell.
    await sleep(5_000);
    await ui('shot', join(SHOTS, `${name}-0-dialog.png`));
    const confirmed = await ui('enter', '', pid);
    notes.push(`paste anyway: exit ${confirmed.code} ${confirmed.out.trim().slice(0, 200)}`);
  }
  await sleep(150_000);
  await ui('shot', join(SHOTS, `${name}-1-after-paste.png`));
  notes.push(`after paste, before any Enter (150 s): token ${tokenUse(token)}`);
  const entered = await ui('enter', '', pid);
  notes.push(`enter: exit ${entered.code} ${entered.out.trim().slice(0, 300)}`);
  await sleep(120_000);
  await ui('shot', join(SHOTS, `${name}-2-after-enter.png`));
  notes.push(`after one Enter (120 s): token ${tokenUse(token)}`);
  killTree(pid);
  return { token, out: notes.join('\n') };
};

// ── the cases ──────────────────────────────────────────────────────────────
const cases = {
  control: async () => {
    const token = 'cm_agent_probe_control';
    return { token, ...(await ps51(pageLines(token).join('\n'))) };
  },
  'cmd-paste': async () => {
    const token = 'cm_agent_probe_cmd';
    return { token, ...(await run('cmd.exe', ['/D'], { stdin: `${pageLines(token).join('\r\n')}\r\nexit\r\n` })) };
  },
  'split-windows': async () => {
    const token = 'cm_agent_probe_split';
    const lines = pageLines(token);
    const first = await ps51(lines.slice(0, 3).join('\n'));
    const second = await ps51(lines[3]);
    return { token, out: `--- window 1 (lines 1-3) ---\n${first.out}\n--- window 2 (line 4) ---\n${second.out}` };
  },
  'no-node': async () => {
    const token = 'cm_agent_probe_nonode';
    const keep = (process.env.PATH || '').split(delimiter)
      .filter((dir) => dir && !['node.exe', 'npm.cmd', 'commonly.cmd'].some((bin) => existsSync(join(dir, bin))));
    return { token, ...(await ps51(pageLines(token).join('\n'), { env: cleanEnv({ PATH: keep.join(delimiter) }) })) };
  },
  'ui-ctrlv': () => uiCase('ui-ctrlv', 'ctrlv'),
  'ui-typed': () => uiCase('ui-typed', 'typed'),
};

const wanted = (process.env.PROBE_CASES || 'all') === 'all'
  ? Object.keys(cases)
  : process.env.PROBE_CASES.split(',').map((s) => s.trim());
log(`node ${process.version}; stub API at ${API}; cases: ${wanted.join(', ')}`);

const summary = [`## Windows BYO probe, node ${process.version}`, ''];
for (const name of wanted) {
  log(`=== ${name} ===`);
  let result;
  try { result = await cases[name](); } catch (err) { result = { token: '', out: `probe error: ${err.stack || err}` }; }
  const tail = String(result.out || '').trim().split(/\r?\n/).slice(-40).join('\n');
  const used = result.token ? tokenUse(result.token) : 'n/a';
  console.log(`::group::${name}: token ${used}`);
  console.log(tail);
  console.log('::endgroup::');
  log(`RESULT ${name}: token ${used}`);
  summary.push(`### ${name}`, `token: ${used}`, '```', tail, '```', '');
}
log(`all requests by token: ${JSON.stringify(Object.fromEntries(seen))}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`);
server.close();
process.exit(0);
