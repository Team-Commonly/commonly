/**
 * `config.runtime.reportedCli`: display only, an unverified self-report.
 *
 * A seat connected with `commonly agent run <name> --adapter claude` never
 * writes `runtime.adapter` (only `commonly agent config --adapter` does), so
 * its chat chip fell back to the install's `runtimeType: 'webhook'` (TASK-317).
 * The CLI now names its adapter on each events poll, and this records it.
 *
 * It is NOT `runtime.adapter` and must never be read as one. `runtime.adapter`
 * is a binding: grant-broker confinement (`grantBrokerConfinement.ts`) judges
 * it, the config write guard refuses changes to it (TASK-474), and the CLI's
 * run path trusts the server-declared adapter for pi. This value comes from
 * whoever holds the runtime token, unverified, so a seat running pi could
 * report "claude". It may only label the chat chip. Anything that grants,
 * refuses or routes reads `runtime.adapter` / `runtimeType`, never this.
 *
 * Written only on a BYO seat (`runtime.host: 'byo'`, which install stamps on
 * every self-serve polling seat) and only while `runtime.adapter` is unset: a
 * declared adapter already names the CLI, and the report must not sit beside it
 * disagreeing. Hosted and native seats never carry it.
 */
import { AgentInstallation } from '../models/AgentRegistry';

/** The CLI's adapter names (`cli/src/lib/adapters/*.js`). */
export const REPORTED_CLI_VALUES: ReadonlySet<string> = new Set([
  'claude', 'codex', 'dsh', 'goose', 'opencode', 'pi', 'qwen',
]);

// (installation, value) -> when this process last wrote it. Entries expire so
// a row whose config was replaced (losing the label) regains it on a later poll.
const RECORD_TTL_MS = 10 * 60 * 1000;
const recorded = new Map<string, number>();
const RECORD_PRUNE_AT = 1000;

export const normalizeReportedCli = (value: unknown): string | null => {
  const cli = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return REPORTED_CLI_VALUES.has(cli) ? cli : null;
};

/**
 * Record the CLI a runtime reported for the installations its token covers.
 * Fire-and-forget: a poll must never wait on or fail for this label. At most
 * one write per (installation, value) per process every ten minutes.
 */
export function recordReportedCli(installationIds: unknown[], value: unknown): void {
  const cli = normalizeReportedCli(value);
  if (!cli) return;
  const now = Date.now();
  // Installations come and go; drop expired entries so churn can't grow the map.
  if (recorded.size > RECORD_PRUNE_AT) {
    recorded.forEach((at, key) => { if (now - at >= RECORD_TTL_MS) recorded.delete(key); });
  }
  const ids = installationIds.map((id) => String(id || '')).filter(Boolean)
    .filter((id) => now - (recorded.get(`${id}:${cli}`) ?? -Infinity) >= RECORD_TTL_MS);
  if (ids.length === 0) return;
  ids.forEach((id) => recorded.set(`${id}:${cli}`, now));
  const forget = () => ids.forEach((id) => recorded.delete(`${id}:${cli}`));
  try {
    AgentInstallation.updateMany(
      {
        _id: { $in: ids },
        'config.runtime.host': 'byo',
        // Matches a missing adapter and an explicit null, both meaning unset.
        'config.runtime.adapter': null,
        'config.runtime.reportedCli': { $ne: cli },
      },
      { $set: { 'config.runtime.reportedCli': cli } },
    ).catch(forget);
  } catch {
    forget();
  }
}

/** Test seam: forget what this process has recorded. */
export function resetReportedCliForTest(): void {
  recorded.clear();
}

/** Test seam: how many (installation, value) entries this process holds. */
export function reportedCliRecordSizeForTest(): number {
  return recorded.size;
}
