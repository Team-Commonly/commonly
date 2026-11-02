/**
 * Who hears about a hosted-MCP pin that drifted upstream (F48).
 *
 * On 2026-11-01 Sentry respelled seven search reads. Each was refused as
 * `tool_drift`, correctly, and the only trace was a `console.warn` nobody
 * reads: the connector sat 7 of 11 tools dark until a template capture tripped
 * over it. The refusal is right. What was missing is a reader.
 *
 * A drift is the catalogue's problem, not the row owner's, so it goes to the
 * operator who re-pins: one Needs-you card per drift (the pin set and the
 * tools that drifted), in a pod that operator can open. Who that is lives in SystemSetting
 * `hostedMcp.driftAlert` (`{ recipientUserId, podId }`), set per instance, so
 * no account or pod id is committed.
 *
 * Only `tool_drift` files. `tool_unavailable` means this row's list lacks the
 * tool, and a list depends on the owner's consent (the Linear smoke row lists
 * 26 pins as absent because its scope is read-only), so it says nothing about
 * the vendor.
 *
 * Like the onboarding alert, this refuses to be silently inert: a drift it
 * cannot deliver is a `console.error` naming why.
 */
import { createHash } from 'crypto';
import {
  digestPinnedDefinition,
  type HostedMcpDriftRow,
  type HostedMcpEntry,
  type HostedMcpToolAssessment,
} from './hostedMcpEntryService';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const SystemSetting = require('../models/SystemSetting');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AttentionItemService = require('./attentionItemService');

export const DRIFT_ALERT_SETTING_KEY = 'hostedMcp.driftAlert';

export interface HostedMcpDriftAlertConfig {
  recipientUserId: string;
  podId: string;
}

export interface HostedMcpDriftCard extends HostedMcpDriftAlertConfig {
  sourceId: string;
  title: string;
  detail: string;
}

export interface HostedMcpDriftAlertDeps {
  readConfig: () => Promise<unknown>;
  record: (card: HostedMcpDriftCard) => Promise<{ recorded: boolean; reason?: string }>;
  now?: () => number;
}

/**
 * An undeliverable drift (no config, a recipient the pod does not list, a
 * failed write) logs again after this long while it lasts. It is never
 * suppressed: the next fresh assessment reads the config and tries to file.
 */
export const DRIFT_ALERT_RELOG_MS = 60 * 60 * 1000;

/**
 * The pin set AND the drifted tools. A re-pin is a new set, so its next drift
 * files afresh; another tool drifting under the same pins, or one only another
 * row's consent can see, is a new drift with its own card.
 */
export const driftAlertSourceId = (entry: HostedMcpEntry, drifted: string[]): string => {
  const pins = entry.tools.map((tool) => digestPinnedDefinition(entry.id, tool)).join('\n');
  const key = `${pins}\n--\n${[...drifted].sort().join('\n')}`;
  return `drift:${entry.id}:${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
};

const OBJECT_ID = /^[0-9a-f]{24}$/i;

// A malformed id would throw a CastError on every write, so it counts as unset.
const configFrom = (value: unknown): HostedMcpDriftAlertConfig | null => {
  const config = value as Partial<HostedMcpDriftAlertConfig> | null | undefined;
  const recipientUserId = String(config?.recipientUserId || '').trim();
  const podId = String(config?.podId || '').trim();
  return OBJECT_ID.test(recipientUserId) && OBJECT_ID.test(podId) ? { recipientUserId, podId } : null;
};

export const createHostedMcpDriftAlert = (deps: HostedMcpDriftAlertDeps) => {
  const now = deps.now || Date.now;
  // Cards this process has filed, keyed by the drift and who it went to: a
  // second row seeing the same drift adds nothing, while a newly configured
  // operator gets their own card. The card's unique index holds across replicas.
  const filed = new Set<string>();
  // When each undeliverable drift last logged, so a drift that persists across
  // many assessments logs hourly rather than on every one.
  const reportedAt = new Map<string, number>();

  return async (row: HostedMcpDriftRow, entry: HostedMcpEntry, tools: HostedMcpToolAssessment[]): Promise<void> => {
    const drifted = tools.filter((tool) => tool.verdict === 'tool_drift').map((tool) => tool.name);
    if (drifted.length === 0) return;
    const sourceId = driftAlertSourceId(entry, drifted);

    // Names come from the pins and the ids from our rows, never from the
    // vendor's descriptions or schemas.
    const report = (delivery: string, reason?: string) => {
      const key = `${sourceId}|${delivery}`;
      const last = reportedAt.get(key);
      if (last !== undefined && now() - last < DRIFT_ALERT_RELOG_MS) return;
      reportedAt.set(key, now());
      console.error(JSON.stringify({
        event: 'hosted_mcp_drift_alert',
        delivery,
        ...(reason ? { reason } : {}),
        entryId: entry.id,
        connectionId: row.connectionId,
        tools: drifted,
      }));
    };
    const failed = (error: unknown) => report('failed', error instanceof Error ? error.message : String(error));

    // Read on every fresh drifted assessment, before the memo: the operator
    // may have been set or changed since the last one.
    let config: HostedMcpDriftAlertConfig | null;
    try {
      config = configFrom(await deps.readConfig());
    } catch (error) {
      failed(error);
      return;
    }
    if (!config) {
      report('unconfigured');
      return;
    }
    const filedKey = `${sourceId}|${config.recipientUserId}|${config.podId}`;
    if (filed.has(filedKey)) return;

    try {
      const result = await deps.record({
        ...config,
        sourceId,
        title: `${entry.title}: ${drifted.length} pinned ${drifted.length === 1 ? 'tool' : 'tools'} changed upstream`,
        detail: `Refused as tool_drift until re-pinned: ${drifted.join(', ')}. `
          + `Seen on connection ${row.connectionId}. Re-pin from a fresh tools/list capture.`,
      });
      if (result.recorded) filed.add(filedKey);
      else report(result.reason || 'not_recorded');
    } catch (error) {
      // Another replica inserted the same card first: it exists, so it is filed.
      if ((error as { code?: unknown })?.code === 11000) {
        filed.add(filedKey);
        return;
      }
      failed(error);
    }
  };
};

export const alertOnHostedMcpDrift = createHostedMcpDriftAlert({
  readConfig: async () => {
    const row = await SystemSetting.findOne({ key: DRIFT_ALERT_SETTING_KEY }).lean() as { value?: unknown } | null;
    return row?.value ?? null;
  },
  record: (card) => AttentionItemService.recordHostedMcpDrift(card),
});
