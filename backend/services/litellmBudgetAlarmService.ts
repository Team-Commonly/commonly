/**
 * LiteLLM key budget alarm (TASK-555).
 *
 * The durable spend caps are LiteLLM virtual-key budgets (max_budget plus
 * budget_duration). They live in LiteLLM's Postgres, so a LiteLLM restart
 * keeps them. Backend and commonly-bot each call on their own budgeted key,
 * and the dsh writers have one. Over a budget, LiteLLM answers 422
 * budget_exceeded and the caller fails. This sweep warns first: at
 * BUDGET_ALARM_FRACTION of any budgeted key it logs one `alarm:
 * litellm_budget` line per key per budget period, and pages SRE the same way
 * the user spend alarm does. A log-based metric turns the line into an email
 * (k8s/monitoring).
 *
 * Group caps in litellm-config.yaml (deployment max_budget) are not covered.
 * LiteLLM keeps their month-to-date figure in the router cache and exposes no
 * endpoint for it, so they are a restart-resettable backstop behind the keys.
 *
 * It reports and never blocks. The master key is needed only to list keys.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const axios = require('axios');

export const BUDGET_ALARM_FRACTION = 0.8;
const PAGE_SIZE = 100;
// A bound on pages, so a malformed total_pages cannot loop the sweep.
const MAX_PAGES = 20;

export interface LiteLLMKeyRow {
  token?: string;
  key_alias?: string | null;
  spend?: number | null;
  max_budget?: number | null;
  budget_duration?: string | null;
  budget_reset_at?: string | null;
}

export interface BudgetAlarm {
  keyAlias: string;
  spendUsd: number;
  maxBudgetUsd: number;
  percent: number;
  budgetDuration: string | null;
  resetsAt: string | null;
}

// The alias names the key in the log and the page. A key without one is
// named by the first 8 characters of LiteLLM's stored hash, which is not the
// key itself. Either way the text is reduced to an identifier, because the
// page lands in an inbox an SRE model session reads.
const keyLabel = (row: LiteLLMKeyRow): string => {
  const alias = String(row.key_alias || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 60);
  if (alias) return alias;
  return `key:${String(row.token || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'unknown'}`;
};

// What remembers an alarm. The label is lossy (two aliases can sanitise to
// the same text), so dedup keys on LiteLLM's stored hash and falls back to
// the raw alias. It is never logged or posted.
const keyIdentity = (row: LiteLLMKeyRow): string => (
  row.token ? `token:${row.token}` : `alias:${String(row.key_alias || '')}`
);

const nearBudget = (row: LiteLLMKeyRow, fraction: number): boolean => (
  Number(row.max_budget) > 0 && Number(row.spend || 0) >= fraction * Number(row.max_budget)
);

export const keysNearBudget = (
  rows: LiteLLMKeyRow[],
  fraction: number = BUDGET_ALARM_FRACTION,
): BudgetAlarm[] => rows
  .filter((row) => nearBudget(row, fraction))
  .map((row) => {
    const spendUsd = Number(row.spend || 0);
    const maxBudgetUsd = Number(row.max_budget);
    return {
      keyAlias: keyLabel(row),
      spendUsd: Number(spendUsd.toFixed(4)),
      maxBudgetUsd,
      percent: Math.round((spendUsd / maxBudgetUsd) * 100),
      budgetDuration: row.budget_duration || null,
      resetsAt: row.budget_reset_at || null,
    };
  });

export interface KeyScan {
  rows: LiteLLMKeyRow[];
  // Set when the scan did not cover every key: /key/list reported more pages
  // than the bound allows, or a page request failed. Either way a budgeted
  // key on a later page went unchecked. The rows already read are kept.
  incomplete: { reason: 'truncated' | 'failed'; pagesRead: number; totalPages: number | null } | null;
}

export const listLiteLLMKeys = async (): Promise<KeyScan | null> => {
  const baseUrl = (process.env.LITELLM_BASE_URL || '').trim().replace(/\/$/, '');
  const masterKey = (process.env.LITELLM_MASTER_KEY || '').trim();
  if (!baseUrl || !masterKey) return null;
  const rows: LiteLLMKeyRow[] = [];
  let totalPages: number | null = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    let resp;
    try {
      // eslint-disable-next-line no-await-in-loop
      resp = await axios.get(`${baseUrl}/key/list`, {
        params: { return_full_object: true, page, size: PAGE_SIZE },
        headers: { Authorization: `Bearer ${masterKey}` },
        timeout: 15000,
      });
    } catch (error) {
      console.warn(`[budget-alarm] /key/list page ${page} failed:`, (error as Error).message);
      return { rows, incomplete: { reason: 'failed', pagesRead: page - 1, totalPages } };
    }
    const keys = Array.isArray(resp?.data?.keys) ? resp.data.keys : [];
    rows.push(...keys);
    const reported = Number(resp?.data?.total_pages);
    if (Number.isInteger(reported) && reported > 0) {
      totalPages = reported;
      if (page >= totalPages) return { rows, incomplete: null };
    } else {
      // No usable total_pages: a short page is the last one, and a full page
      // means more may follow, so keep reading rather than call it complete.
      totalPages = null;
      if (keys.length < PAGE_SIZE) return { rows, incomplete: null };
    }
    // An empty page that still reports more pages is not the end of the list.
    if (keys.length === 0) return { rows, incomplete: { reason: 'failed', pagesRead: page, totalPages } };
    if (page === MAX_PAGES) return { rows, incomplete: { reason: 'truncated', pagesRead: page, totalPages } };
  }
  return { rows, incomplete: null };
};

export const composeBudgetPage = (alarm: BudgetAlarm, mention?: string): string => {
  const handle = mention ? ` @${mention}` : '';
  const reset = alarm.resetsAt ? ` It resets ${alarm.resetsAt}.` : '';
  return `[budget alarm] LiteLLM key ${alarm.keyAlias} has spent $${alarm.spendUsd.toFixed(2)} of its `
    + `$${alarm.maxBudgetUsd} budget (${alarm.percent}%). At 100% its calls fail.${reset}${handle}`;
};

// Two memories, in process only like the user spend alarm (after a restart a
// key still over the line is logged once more). `alarmed` holds keys already
// logged this budget period, keyed on the key and its reset time. `unpaged`
// holds logged alarms whose SRE page has not gone out yet, so a failed post
// is retried on the next sweep instead of being lost. The log line is what
// the email alert counts, so it is never repeated for a retry.
const alarmed = new Set<string>();
const unpaged = new Map<string, BudgetAlarm>();
// An incomplete scan logs once, and again only after a complete scan in
// between, so a lasting failure is one alert rather than one every sweep.
// Its SRE page is held until it is delivered, like the key pages.
let incompleteLogged = false;
let unconfiguredLogged = false;
let unpagedScan: string | null = null;

// The scan needs both of these. LITELLM_BASE_URL or a service key being set
// means this deployment uses LiteLLM, so a missing piece is an alarm, not a
// quiet skip. With none of the three set there is no LiteLLM to watch.
const SCAN_ENV = ['LITELLM_BASE_URL', 'LITELLM_MASTER_KEY'];
const setEnv = (name: string): boolean => Boolean((process.env[name] || '').trim());

const sendPage = async (content: string): Promise<boolean> => {
  try {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const { pageSre } = require('./spendAlarmService');
    await pageSre(content);
    return true;
  } catch (error) {
    console.warn('[budget-alarm] SRE page failed; it is retried next sweep:', (error as Error).message);
    return false;
  }
};

export const checkLiteLLMBudgets = async (): Promise<BudgetAlarm[]> => {
  const scan = await listLiteLLMKeys();
  const mention = String(process.env.SPEND_ALARM_MENTION || '').trim() || undefined;
  if (!scan) {
    const missing = SCAN_ENV.filter((name) => !setEnv(name));
    const usesLiteLLM = [...SCAN_ENV, 'LITELLM_API_KEY'].some(setEnv);
    if (usesLiteLLM && !unconfiguredLogged) {
      unconfiguredLogged = true;
      console.warn(JSON.stringify({ alarm: 'litellm_budget', scanUnconfigured: missing }));
      const handle = mention ? ` @${mention}` : '';
      unpagedScan = `[budget alarm] The LiteLLM key scan cannot run because ${missing.join(' and ')} `
        + `${missing.length === 1 ? 'is' : 'are'} not set, so no key is checked against its budget.${handle}`;
    }
    if (unpagedScan && await sendPage(unpagedScan)) unpagedScan = null;
    return [];
  }
  unconfiguredLogged = false;

  // An incomplete scan can hide a key near its budget, so it alarms too, on
  // the same metric, toward over-delivery. The rows it did read are checked.
  if (!scan.incomplete) {
    incompleteLogged = false;
  } else if (!incompleteLogged) {
    incompleteLogged = true;
    const { reason, pagesRead, totalPages } = scan.incomplete;
    console.warn(JSON.stringify({ alarm: 'litellm_budget', scanIncomplete: reason, pagesRead, totalPages }));
    const handle = mention ? ` @${mention}` : '';
    const what = reason === 'failed'
      ? `failed after ${pagesRead} page${pagesRead === 1 ? '' : 's'}`
      : `stopped at ${pagesRead} of ${totalPages} pages`;
    unpagedScan = `[budget alarm] The LiteLLM key scan ${what}, so some keys were not checked against their budget.${handle}`;
  }
  if (unpagedScan && await sendPage(unpagedScan)) unpagedScan = null;

  const fresh: BudgetAlarm[] = [];
  scan.rows.filter((row) => nearBudget(row, BUDGET_ALARM_FRACTION)).forEach((row) => {
    const id = `${keyIdentity(row)}:${row.budget_reset_at || null}`;
    if (alarmed.has(id)) return;
    const [alarm] = keysNearBudget([row]);
    alarmed.add(id);
    unpaged.set(id, alarm);
    fresh.push(alarm);
    console.warn(JSON.stringify({ alarm: 'litellm_budget', thresholdFraction: BUDGET_ALARM_FRACTION, ...alarm }));
  });

  for (const [id, alarm] of [...unpaged.entries()]) {
    // eslint-disable-next-line no-await-in-loop
    if (await sendPage(composeBudgetPage(alarm, mention))) unpaged.delete(id);
  }
  return fresh;
};

/** Test seam: forget which keys were already logged and paged. */
export const resetBudgetAlarmMemory = (): void => {
  alarmed.clear();
  unpaged.clear();
  incompleteLogged = false;
  unconfiguredLogged = false;
  unpagedScan = null;
};
