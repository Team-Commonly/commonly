/**
 * AgentRun content window (F84, ruled 2026-11-04).
 *
 * A run stores the model's text, each tool call's args, result and error,
 * and its own errorMessage, any of which can carry connector data (a calendar
 * event, an issue body, an exception that echoed either). Nothing in the
 * product reads any of them back: every AgentRun reader selects metadata only.
 * So after RUN_CONTENT_WINDOW_DAYS they are unset and the
 * row stays, with its status, errorKind, trigger, tokens, timings, models and
 * tool names, so proof of life, recent activity, traces and spend history are
 * unchanged. No row is deleted.
 */
import AgentRun from '../models/AgentRun';

export const RUN_CONTENT_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// Drop `keys` from an embedded object. Aggregation, so a turn or tool call
// missing the field (or the array) is handled without a per-row path error.
const without = (input: string, keys: string[]) => ({
  $arrayToObject: {
    $filter: {
      input: { $objectToArray: input },
      as: 'kv',
      cond: { $not: [{ $in: ['$$kv.k', keys] }] },
    },
  },
});

export interface RunContentWindowReport {
  cutoff: Date;
  matched: number;
  redacted: number;
}

/**
 * Unset the content of runs started before the window. `apply: false` (the
 * default) only counts what it would redact.
 */
export const redactExpiredRunContent = async (
  { apply = false, now = new Date() }: { apply?: boolean; now?: Date } = {},
): Promise<RunContentWindowReport> => {
  const cutoff = new Date(now.getTime() - RUN_CONTENT_WINDOW_DAYS * DAY_MS);
  const filter = { startedAt: { $lt: cutoff }, contentRedactedAt: { $exists: false } };
  const matched = await AgentRun.countDocuments(filter);
  if (!apply || matched === 0) return { cutoff, matched, redacted: 0 };

  const result = await AgentRun.collection.updateMany(filter, [
    {
      $set: {
        turns: {
          $map: {
            input: { $ifNull: ['$turns', []] },
            as: 'turn',
            in: {
              $mergeObjects: [
                without('$$turn', ['llmResponseText', 'toolCalls']),
                {
                  toolCalls: {
                    $map: {
                      input: { $ifNull: ['$$turn.toolCalls', []] },
                      as: 'call',
                      in: without('$$call', ['args', 'result', 'error']),
                    },
                  },
                },
              ],
            },
          },
        },
        contentRedactedAt: now,
      },
    },
    { $unset: 'errorMessage' },
  ]);
  return { cutoff, matched, redacted: result.modifiedCount };
};
