// The newest timestamp per agent install, in one round trip, reading one
// index entry per install (TASK-774).
//
// The shape this replaces, `$match` every row for these installs → `$sort` →
// `$group` with `$first`, reads every matching row to keep one per install,
// so its cost grows with history: on 11-04 the roster's heartbeat read
// fetched a week of every delivered event its seats had in every pod, and
// the route drew 504s at nginx's 5 s. Here each install gets its own
// `$match` → `$sort` → `$limit: 1` branch, joined with `$unionWith`, so each
// branch is one seek on an index that ends in the sorted field. The model
// needs that index: equality on every field `match` names, then `field`
// descending (or ascending: Mongo walks it backwards).

const PAIRS_PER_PIPELINE = 50;

export interface InstallLike {
  agentName?: string | null;
  instanceId?: string | null;
}

export interface InstallPair {
  agentName: string;
  instanceId: string;
}

/** The roster's key for an install: `agentName:instanceId`, `default` when unset. */
export const installKey = (agentName: string, instanceId?: string | null): string => (
  `${agentName}:${instanceId || 'default'}`
);

interface AggregatableModel {
  aggregate: (pipeline: Record<string, unknown>[]) => PromiseLike<unknown[]>;
  collection?: { collectionName?: string };
}

/**
 * For each distinct install, the newest `field` among the rows `match(pair)`
 * selects, keyed by `installKey`. An install with no rows has no entry.
 * Installs are deduplicated; more than PAIRS_PER_PIPELINE run as several
 * aggregates, one after another.
 */
export const newestPerInstall = async (
  model: AggregatableModel,
  installs: InstallLike[],
  { match, field }: { match: (pair: InstallPair) => Record<string, unknown>; field: string },
): Promise<Map<string, Date>> => {
  const pairs = new Map<string, InstallPair>();
  for (const install of installs) {
    if (!install?.agentName) continue;
    const pair = { agentName: install.agentName, instanceId: install.instanceId || 'default' };
    pairs.set(installKey(pair.agentName, pair.instanceId), pair);
  }
  const result = new Map<string, Date>();
  const entries = Array.from(pairs.entries());
  const branch = ([key, pair]: [string, InstallPair]) => [
    { $match: match(pair) },
    { $sort: { [field]: -1 } },
    { $limit: 1 },
    { $project: { _id: 0, key: { $literal: key }, at: `$${field}` } },
  ];
  for (let start = 0; start < entries.length; start += PAIRS_PER_PIPELINE) {
    const [first, ...rest] = entries.slice(start, start + PAIRS_PER_PIPELINE);
    // eslint-disable-next-line no-await-in-loop
    const rows = await model.aggregate([
      ...branch(first),
      ...rest.map((entry) => ({
        $unionWith: { coll: model.collection?.collectionName, pipeline: branch(entry) },
      })),
    ]) as Array<{ key: string; at?: Date | null }>;
    for (const row of rows) {
      if (row.at) result.set(row.key, row.at);
    }
  }
  return result;
};
