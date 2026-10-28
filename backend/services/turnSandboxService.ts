/**
 * The run-code sandbox for native turns (TASK-266, ADR-023 amendment A2).
 *
 * One E2B sandbox per turn: created on the turn's first `commonly_run_code`
 * call and killed when the turn ends, whatever the outcome.
 *
 * - No internet (`allowInternetAccess: false`). The model writing this code
 *   holds pod content, so outbound access would turn any injected instruction
 *   into an exfiltration channel.
 * - No public inbound either (`allowPublicTraffic: false`): sandbox URLs need
 *   a traffic token that only this process holds.
 * - No environment variables, so no secret is ever inside it.
 * - E2B's own sandbox lifetime (SANDBOX_LIFETIME_MS) is the backstop: if the
 *   kill fails, the sandbox stops itself, and its billed seconds stay bounded.
 *   E2B has no spending cap, so the per-user spend alarm (TASK-263) prices the
 *   seconds recorded on the AgentRun.
 */

// Pinned, not left to the SDK's default: the spend alarm prices this shape
// (services/spendAlarmService.ts), and an SDK upgrade must not change it
// silently. code-interpreter 2.9.0's default is the same template.
export const SANDBOX_TEMPLATE = 'code-interpreter-v1';
const SANDBOX_LIFETIME_MS = 3 * 60 * 1000;
const RUN_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 45_000;
// Bounds the create call itself: a hung E2B control plane must not hold the turn.
const CREATE_TIMEOUT_MS = 30_000;
// What the model is told when E2B refuses a sandbox (concurrency cap, rate
// limit, or a create that timed out). The raw SDK message stays server-side.
export const SANDBOX_BUSY_MESSAGE = 'sandbox busy, try again in a minute';
const MAX_CODE_CHARS = 20_000;
const STDOUT_LIMIT = 4000;
const STDERR_LIMIT = 2000;
export const MAX_RUNS_PER_TURN = 5;
export const RUN_CODE_LANGUAGES: readonly string[] = ['python', 'javascript'];

export const isSandboxConfigured = (): boolean => Boolean(process.env.E2B_API_KEY);

// The slice of @e2b/code-interpreter this service uses, typed locally so the
// module is loaded only when a turn actually runs code.
interface E2BExecution {
  logs: { stdout: string[]; stderr: string[] };
  error?: { name: string; value: string; traceback: string };
  text?: string;
}
interface E2BSandbox {
  runCode(code: string, opts: Record<string, unknown>): Promise<E2BExecution>;
  kill(): Promise<boolean>;
}

export interface RunCodeResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  result?: string;
  error?: string;
}

// E2B's own refusal classes: RateLimitError (cap or 429), ServiceBusyError (503,
// capacity), TimeoutError (create ran past its request timeout). Anything else is
// a fault, and still throws.
const isSandboxRefusal = (error: unknown): boolean => {
  const { name, status, statusCode } = (error || {}) as { name?: string; status?: number; statusCode?: number };
  return name === 'RateLimitError' || name === 'ServiceBusyError' || name === 'TimeoutError'
    || status === 429 || statusCode === 429 || statusCode === 503;
};

// The pinned SDK does not honour requestTimeoutMs on Sandbox.create, so the
// bound is ours: a hung control plane must not hold the turn. A create that
// answers after the bound is killed on arrival, so it is not billed until its
// lifetime runs out.
const boundCreate = (create: Promise<E2BSandbox>, ms: number): Promise<E2BSandbox> => new Promise((resolve, reject) => {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    const error = new Error(`sandbox create did not answer within ${ms}ms`);
    error.name = 'TimeoutError';
    reject(error);
  }, ms);
  create.then((sandbox) => {
    clearTimeout(timer);
    if (timedOut) {
      sandbox.kill().catch(() => {});
      return;
    }
    resolve(sandbox);
  }, (error) => {
    clearTimeout(timer);
    reject(error);
  });
});

const clip = (text: string, limit: number): string => (
  text.length > limit ? `${text.slice(0, limit)}\n… [${text.length - limit} more characters]` : text
);

export class TurnSandbox {
  private creating: Promise<E2BSandbox> | null = null;

  private startedAt = 0;

  private runs = 0;

  private readonly metadata: Record<string, string>;

  constructor(metadata: Record<string, string>) {
    this.metadata = metadata;
  }

  private open(): Promise<E2BSandbox> {
    if (!this.creating) {
      // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
      const { Sandbox } = require('@e2b/code-interpreter');
      this.startedAt = Date.now();
      const create = Sandbox.create(SANDBOX_TEMPLATE, {
        apiKey: process.env.E2B_API_KEY,
        timeoutMs: SANDBOX_LIFETIME_MS,
        requestTimeoutMs: CREATE_TIMEOUT_MS,
        allowInternetAccess: false,
        // E2B serves every sandbox port on a public URL unless told not to;
        // with this off, a URL needs the traffic token only this process holds,
        // so a server started inside cannot be reached from outside (Rhea on
        // #2232). The code-interpreter client sends that token on every call.
        network: { allowPublicTraffic: false },
        envs: {},
        metadata: this.metadata,
      }) as Promise<E2BSandbox>;
      this.creating = boundCreate(create, CREATE_TIMEOUT_MS);
    }
    return this.creating;
  }

  async run(language: string, code: string): Promise<RunCodeResult> {
    const refuse = (error: string): RunCodeResult => ({ ok: false, stdout: '', stderr: '', error });
    if (!RUN_CODE_LANGUAGES.includes(language)) return refuse(`language must be one of: ${RUN_CODE_LANGUAGES.join(', ')}`);
    if (!code.trim()) return refuse('code is empty');
    if (code.length > MAX_CODE_CHARS) return refuse(`code is longer than ${MAX_CODE_CHARS} characters`);
    if (this.runs >= MAX_RUNS_PER_TURN) return refuse(`this turn has used its ${MAX_RUNS_PER_TURN} code runs`);
    this.runs += 1;

    let sandbox: E2BSandbox;
    try {
      sandbox = await this.open();
    } catch (error) {
      if (!isSandboxRefusal(error)) throw error;
      // Forget the failed create, so close() has nothing to kill and a later run may try again.
      this.creating = null;
      console.warn('[sandbox] E2B refused a sandbox:', (error as Error).name);
      return refuse(SANDBOX_BUSY_MESSAGE);
    }
    const execution = await sandbox.runCode(code, {
      language, timeoutMs: RUN_TIMEOUT_MS, requestTimeoutMs: REQUEST_TIMEOUT_MS, envs: {},
    });
    return {
      ok: !execution.error,
      stdout: clip((execution.logs?.stdout || []).join(''), STDOUT_LIMIT),
      stderr: clip((execution.logs?.stderr || []).join(''), STDERR_LIMIT),
      ...(execution.text ? { result: clip(execution.text, STDOUT_LIMIT) } : {}),
      ...(execution.error ? {
        error: clip(`${execution.error.name}: ${execution.error.value}\n${execution.error.traceback || ''}`, STDERR_LIMIT),
      } : {}),
    };
  }

  /**
   * Kills the sandbox if this turn opened one, and returns the seconds it ran
   * (0 when no code ran). Never throws: a failed kill is logged, and E2B stops
   * the sandbox at its lifetime.
   */
  async close(): Promise<number> {
    if (!this.creating) return 0;
    const seconds = Math.max(1, Math.ceil((Date.now() - this.startedAt) / 1000));
    try {
      const sandbox = await this.creating;
      await sandbox.kill();
    } catch (error) {
      console.warn('[sandbox] close failed; E2B stops it at its lifetime:', (error as Error).message);
    }
    return seconds;
  }
}
