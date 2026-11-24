/**
 * OpenShell as the run-code sandbox for native turns: a spike behind a flag (D343).
 *
 * This is the ADR-008 driver for `sandbox.mode: container` on the hosted path.
 * It runs a turn's `commonly_run_code` in an OpenShell sandbox (Docker driver,
 * Landlock + seccomp, network fence) instead of an E2B sandbox. It keeps the
 * same contract as TurnSandbox in turnSandboxService.ts: one sandbox per turn,
 * created on the first run, deleted when the turn ends.
 *
 * Results and limits: docs/plans/openshell-spike.md.
 *
 * - No egress. The policy this file writes has no network rules, and OpenShell
 *   denies every outbound connection that no rule allows. The model writing
 *   this code holds pod content, so outbound access would turn any injected
 *   instruction into an exfiltration channel. This is the same rule as E2B's
 *   `allowInternetAccess: false`.
 * - No secrets. The sandbox gets no environment. The CLI process gets only the
 *   OpenShell variables it needs, never the backend's environment, because the
 *   CLI is outside code.
 * - Front ports are the one way out, for a later hosted agent that has to
 *   reach Commonly's provider proxy or grant broker. A host.openshell.internal
 *   rule reaches services bound only to the gateway host's loopback (measured
 *   in the spike), so a port on the database and control-plane list is
 *   refused. The run-code path passes none.
 * - The backstop is the sandbox's own main process: `sleep` for
 *   SANDBOX_LIFETIME_S with --no-keep, so a failed delete still ends.
 */
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { mkdtempSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

const SANDBOX_LIFETIME_S = 180;
const RUN_TIMEOUT_S = 30;
const CREATE_TIMEOUT_MS = 30_000;
const DELETE_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 500;
const MAX_CODE_CHARS = 20_000;
const STDOUT_LIMIT = 4000;
const STDERR_LIMIT = 2000;
export const MAX_RUNS_PER_TURN = 5;
export const SANDBOX_BUSY_MESSAGE = 'sandbox busy, try again in a minute';
const INTERPRETERS: Readonly<Record<string, string[]>> = {
  python: ['python3', '-'],
  javascript: ['node', '-'],
};

// Ports a front rule must never name. A host.openshell.internal rule reaches
// the gateway host's loopback, where these services listen on a single-VM
// install: Postgres, Mongo, Redis, the Docker API, the OpenShell gateway and
// its health port, LiteLLM, and SSH.
export const REFUSED_FRONT_PORTS: readonly number[] = [22, 2375, 2376, 4000, 5432, 6379, 8080, 8081, 27017];

/** The flag, and the image, which must carry python3 and node (the default Ubuntu image has neither). */
export const isOpenShellSandboxEnabled = (): boolean => (
  process.env.OPENSHELL_SANDBOX_ENABLED === 'true' && Boolean(process.env.OPENSHELL_SANDBOX_IMAGE)
);

interface RunCodeResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  result?: string;
  error?: string;
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type CliRunner = (args: string[], opts: { input?: string; timeoutMs: number }) => Promise<CliResult>;

/**
 * The policy: filesystem as OpenShell's default (workdir read-write, system
 * paths read-only) and, without front ports, no network rule at all.
 */
export const buildSandboxPolicy = ({ frontPorts = [] }: { frontPorts?: number[] } = {}): string => {
  for (const port of frontPorts) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`front port ${port} is not a port`);
    if (REFUSED_FRONT_PORTS.includes(port)) throw new Error(`front port ${port} is refused: it reaches a host service`);
  }
  const lines = [
    'version: 1',
    'filesystem_policy:',
    '  include_workdir: true',
    '  read_only: [/usr, /lib, /etc, /proc, /dev/urandom, /var/log]',
    '  read_write: [/sandbox, /tmp, /dev/null]',
    'landlock:',
    '  compatibility: best_effort',
  ];
  if (frontPorts.length) {
    lines.push('network_policies:', '  commonly_front:', '    name: commonly-front', '    endpoints:');
    for (const port of frontPorts) lines.push(`      - { host: host.openshell.internal, port: ${port} }`);
    lines.push('    binaries:', '      - { path: /usr/local/bin/node }', '      - { path: "/usr/local/lib/node_modules/**" }');
  } else {
    lines.push('network_policies: {}');
  }
  return `${lines.join('\n')}\n`;
};

/** The CLI's environment: its own variables only, never the backend's secrets. */
export const cliEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const keep = ['PATH', 'HOME', 'XDG_CONFIG_HOME', 'OPENSHELL_GATEWAY', 'OPENSHELL_GATEWAY_ENDPOINT'];
  const out: NodeJS.ProcessEnv = {};
  for (const key of keep) if (env[key]) out[key] = env[key];
  return out;
};

const clip = (text: string, limit: number): string => (
  text.length > limit ? `${text.slice(0, limit)}\n… [${text.length - limit} more characters]` : text
);

// Collects at most `cap` characters per stream, so a runaway print cannot grow memory.
const defaultRunner: CliRunner = (args, { input, timeoutMs }) => new Promise((resolve) => {
  const cap = STDOUT_LIMIT * 4;
  const child = spawn(process.env.OPENSHELL_BIN || 'openshell', args, {
    env: cliEnv(process.env), stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  child.stdout.on('data', (chunk) => { if (stdout.length < cap) stdout += chunk; });
  child.stderr.on('data', (chunk) => { if (stderr.length < cap) stderr += chunk; });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  child.on('error', (error) => {
    clearTimeout(timer);
    resolve({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut });
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    resolve({ code, stdout, stderr, timedOut });
  });
  child.stdin.on('error', () => { /* the CLI exited before reading stdin */ });
  child.stdin.end(input ?? '');
});

let policyFile: string | null = null;
const noEgressPolicyFile = (): string => {
  if (!policyFile) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'openshell-policy-'));
    policyFile = path.join(dir, 'turn-policy.yaml');
    writeFileSync(policyFile, buildSandboxPolicy(), { mode: 0o600 });
  }
  return policyFile;
};

const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

export class OpenShellTurnSandbox {
  private creating: Promise<void> | null = null;

  private runs = 0;

  // The gateway caps sandbox names at 19 characters (0.1.9): this is 18.
  private readonly name = `cm-turn-${randomBytes(5).toString('hex')}`;

  private readonly metadata: Record<string, string>;

  private readonly cli: CliRunner;

  private readonly pollMs: number;

  constructor(metadata: Record<string, string>, deps: { cli?: CliRunner; pollMs?: number } = {}) {
    this.metadata = metadata;
    this.cli = deps.cli || defaultRunner;
    this.pollMs = deps.pollMs ?? READY_POLL_MS;
  }

  private async create(): Promise<void> {
    const deadline = Date.now() + CREATE_TIMEOUT_MS;
    const created = await this.cli([
      'sandbox', 'create', '--name', this.name,
      '--from', String(process.env.OPENSHELL_SANDBOX_IMAGE),
      '--policy', process.env.OPENSHELL_SANDBOX_POLICY_FILE || noEgressPolicyFile(),
      '--cpu', '1', '--memory', '512Mi',
      '--label', 'app=commonly-turn',
      // The CLI refuses --no-keep with --output, so the create's output is not parsed.
      '--detach', '--no-keep',
      '--', 'sleep', String(SANDBOX_LIFETIME_S),
    ], { timeoutMs: CREATE_TIMEOUT_MS });
    // Exit 2 (the CLI refusing its own arguments) and the gateway's "invalid
    // argument" are a fault in this file or a version change, not a busy
    // gateway, so they throw instead of reading as "busy".
    if (created.code === 2 || /invalid argument/i.test(created.stderr)) {
      throw new Error(`openshell refused the create arguments: ${clip(created.stderr, 300)}`);
    }
    if (created.code !== 0) throw Object.assign(new Error(`sandbox create failed: ${clip(created.stderr, 300)}`), { refusal: true });
    for (;;) {
      const got = await this.cli(['sandbox', 'get', this.name, '--output', 'json'], { timeoutMs: 10_000 });
      const phase = /"phase"\s*:\s*"([A-Za-z]+)"/.exec(got.stdout)?.[1];
      if (phase === 'Ready') return;
      if (phase === 'Error' || Date.now() > deadline) {
        throw Object.assign(new Error(`sandbox not ready (${phase || 'no phase'})`), { refusal: true });
      }
      await sleep(this.pollMs);
    }
  }

  async run(language: string, code: string): Promise<RunCodeResult> {
    const refuse = (error: string): RunCodeResult => ({ ok: false, stdout: '', stderr: '', error });
    const interpreter = INTERPRETERS[language];
    if (!interpreter) return refuse(`language must be one of: ${Object.keys(INTERPRETERS).join(', ')}`);
    if (!code.trim()) return refuse('code is empty');
    if (code.length > MAX_CODE_CHARS) return refuse(`code is longer than ${MAX_CODE_CHARS} characters`);
    if (this.runs >= MAX_RUNS_PER_TURN) return refuse(`this turn has used its ${MAX_RUNS_PER_TURN} code runs`);
    this.runs += 1;

    try {
      if (!this.creating) this.creating = this.create();
      await this.creating;
    } catch (error) {
      if (!(error as { refusal?: boolean }).refusal) throw error;
      // Delete what may exist, then forget it, so a later run may try again.
      await this.close();
      this.creating = null;
      console.warn('[sandbox] OpenShell refused a sandbox:', (error as Error).message, this.metadata);
      return refuse(SANDBOX_BUSY_MESSAGE);
    }
    const ran = await this.cli([
      'sandbox', 'exec', '-n', this.name, '--no-login-shell', '--no-tty',
      '--timeout', String(RUN_TIMEOUT_S), '--', ...interpreter,
    ], { input: code, timeoutMs: (RUN_TIMEOUT_S + 5) * 1000 });
    // OpenShell's own --timeout ends the command with exit 124 (measured, 0.1.9);
    // our kill is the backstop if the CLI itself hangs.
    if (ran.timedOut || ran.code === 124) {
      return { ...refuse(`code ran past ${RUN_TIMEOUT_S}s`), stdout: clip(ran.stdout, STDOUT_LIMIT) };
    }
    return {
      ok: ran.code === 0,
      stdout: clip(ran.stdout, STDOUT_LIMIT),
      stderr: clip(ran.stderr, STDERR_LIMIT),
      ...(ran.code === 0 ? {} : { error: `exited with code ${ran.code}` }),
    };
  }

  /**
   * Deletes the sandbox if this turn opened one. Returns 0: a self-hosted
   * sandbox has no per-second vendor bill, and the spend alarm prices
   * sandboxSeconds as E2B time. Never throws; the sandbox's own lifetime is
   * the backstop.
   */
  async close(): Promise<number> {
    if (!this.creating) return 0;
    try {
      const deleted = await this.cli(['sandbox', 'delete', this.name], { timeoutMs: DELETE_TIMEOUT_MS });
      if (deleted.code !== 0) console.warn('[sandbox] OpenShell delete failed; its lifetime ends it:', clip(deleted.stderr, 200));
    } catch (error) {
      console.warn('[sandbox] OpenShell delete failed; its lifetime ends it:', (error as Error).message);
    }
    return 0;
  }
}
