/**
 * Write-time shape check for a seat's `config.environment.mcp` entries.
 *
 * WHY THIS IS A WRITE-TIME CHECK AND NOT A READ-TIME ONE (TASK-071).
 *
 * `config.environment` on an AgentInstallation is projected onto the owner's
 * daemon (backend/services/seatEnvironmentProjection.ts, consumed by
 * `GET /api/agent-binding/assigned`) and becomes the seat's DECLARED spec, so
 * an entry here is not inert prose: every adapter branches on its shape and
 * runs something because of it. There are TWO backend writers of that field —
 * `PATCH /api/registry/pods/:podId/agents/:name` (which merged `config`
 * wholesale) and `POST /api/registry/install` (which stores the body's config
 * through `normalizeConfigMap`, a passthrough for a plain object) — and neither
 * had a shape check, so a body could store an entry whose fields contradict its
 * own transport and the readers were left to resolve it. Both now call this.
 * The first draft of this file said the PATCH was the only writer; Vera found
 * the second one in review (70201), which is why the claim is spelled out as a
 * count rather than left as "the writer".
 *
 * They resolve it differently, which is the defect rather than a detail:
 * `pi-mcp-client.mjs` keeps "exactly one of command/url per entry" as an
 * invariant and resolves a hand-built both-fields entry URL-FIRST (:80-85),
 * while its `readServers` filter DROPS an entry that is neither a command array
 * nor a url (:342-355). One stored record, three adapters, no single answer to
 * "what runs?".
 *
 * THE RULE (Vera, ruling on TASK-071, 2026-09-19) — a transport decides the
 * entry, so the fields must agree with it:
 *
 *   transport http | sse   ⇒ `url` required, `command` forbidden
 *   transport stdio, or absent ⇒ `command` required, `url` forbidden
 *
 * `transport` absent means stdio deliberately: that is the historical default
 * this repo's own default declaration relies on (`commonlyMcpServer()` sets
 * `transport: 'stdio'` explicitly, but older stored rows do not).
 *
 * `command` IS AN ARGV ARRAY, NOT A STRING. Every consumer agrees:
 * `connectStdioMcp` destructures `const [cmd, ...args] = command`
 * (cli/src/lib/adapters/pi-mcp-client.mjs:90-91) and `isStdioServer` is
 * `Array.isArray(s?.command) && s.command.length > 0` (:342), while `url` is
 * always the string form `typeof s?.url === 'string' && s.url.length > 0`
 * (:344). A string `command` is therefore not a near-miss — it is an entry the
 * pi path currently drops in silence, so the array requirement is part of the
 * agreement rule rather than a separate nicety.
 *
 * MIRRORED, NOT SHARED. The CLI's `validateEnvironmentSpec` carries the same
 * mcp block for the other write path, an operator-authored `--environment
 * <file>` (cli/src/lib/environment.js). The two cannot share code at runtime —
 * this is the CJS backend, that is a published ESM package with its own
 * dependency closure — so this is a deliberate mirror and the two must move
 * together. The CLI refuses a hand-written file; this refuses a stored row.
 *
 * NOT `validateMcpComponent`. That validator owns the PLUGIN MANIFEST shape
 * (`mcpServers` in a plugin.json, backend/utils/pluginManifestParser.ts) and
 * NORMALIZES as it validates, dropping every field its `IComponent` shape does
 * not carry. A seat environment entry carries `env` — the default declaration
 * puts a token reference there (cli/src/lib/default-environment.js) — so
 * routing this path through that normalizer would trade a shape bug for a
 * data-loss bug.
 *
 * SCOPE, stated so it is not assumed: only the mcp entries are checked here,
 * and only the ones THIS REQUEST declares. The rest of an environment spec
 * (`version`, `sandbox`, `skills`, `model`, `effort`) is the CLI validator's
 * business, and a caller patching an unrelated field is never refused for a
 * sibling's shape — otherwise a row that already holds a malformed entry would
 * be unpatchable, and refusing old records is not what this rule is for.
 */
export type EnvironmentSpecError = { field: string; message: string };

const TRANSPORTS = ['http', 'stdio', 'sse'];

const nonEmptyString = (value: unknown): boolean => (
  typeof value === 'string' && value.trim().length > 0
);

const argv = (value: unknown): string[] | null => (
  Array.isArray(value) && value.length > 0 && value.every((part) => nonEmptyString(part))
    ? (value as string[])
    : null
);

/**
 * Validate the `mcp` entries of a seat environment spec.
 *
 * Returns every error rather than the first, because a single PATCH can carry
 * several entries and a caller fixing one per round trip is a worse surface
 * than a list. An empty array means "nothing here this check objects to" — it
 * is not a statement that the spec is otherwise valid.
 */
export const validateEnvironmentMcpEntries = (environment: unknown): EnvironmentSpecError[] => {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) return [];
  const entries = (environment as Record<string, unknown>).mcp;
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) {
    return [{ field: 'environment.mcp', message: 'must be an array' }];
  }

  const errors: EnvironmentSpecError[] = [];

  entries.forEach((entry: unknown, i: number) => {
    const at = `environment.mcp[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push({ field: at, message: 'must be an object' });
      return;
    }

    const record = entry as Record<string, unknown>;

    if (!nonEmptyString(record.name)) {
      errors.push({ field: `${at}.name`, message: 'is required and must be a non-empty string' });
    }

    const { transport } = record;
    if (transport !== undefined && !TRANSPORTS.includes(String(transport))) {
      errors.push({
        field: `${at}.transport`,
        message: `must be one of: ${TRANSPORTS.join(', ')} — an unknown transport leaves`
          + ' every reader to infer one from which field happens to be present',
      });
      // The agreement rule below is defined in terms of a transport this
      // record does not have, so judging it here would mean inventing the
      // second definition this rule exists to avoid.
      return;
    }

    const command = argv(record.command);
    const hasUrl = nonEmptyString(record.url);
    const remote = transport === 'http' || transport === 'sse';

    if (remote) {
      if (!hasUrl) {
        errors.push({
          field: `${at}.url`,
          message: `is required when transport is ${transport}: a ${transport} server is`
            + ' reached by URL, and this entry declares no URL to reach',
        });
      }
      if (record.command !== undefined) {
        errors.push({
          field: `${at}.command`,
          message: `must not be set when transport is ${transport}: with a url and a command`
            + ' in one entry each reader picks a different winner, so the record does'
            + ' not say what runs',
        });
      }
      return;
    }

    // stdio, or absent transport — the historical default.
    if (!command) {
      errors.push({
        field: `${at}.command`,
        message: record.command === undefined
          ? 'is required for a stdio entry (and for an entry that declares no transport):'
            + ' with no command and no url there is nothing to run'
          : 'must be a non-empty array of strings (argv, e.g. ["npx", "-y",'
            + ' "@commonlyai/mcp@latest"]); a string command is not a command line any'
            + ' reader in this repo executes',
      });
    }
    if (hasUrl) {
      errors.push({
        field: `${at}.url`,
        message: 'must not be set for a stdio entry (and for an entry that declares no'
          + ' transport): a url here is a second, contradictory way to reach the server',
      });
    }
  });

  return errors;
};
