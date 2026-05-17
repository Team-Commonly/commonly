// Decorates ReactionSummary[] (from MessageReaction.listForMessage[s])
// with the reactor's username + displayName so the kernel response
// carries enough attribution for the UI to render "Nova, Sam (you)
// reacted with 🎉" tooltips. Same shape served on add/remove HTTP
// responses, the messageReaction socket fan-out, and the bulk messages
// list path — one source of truth here.
//
// For bot reactors, displayName is resolved via
// agentIdentityService.resolveAgentDisplayLabel so the UI gets "Nova"
// rather than the raw "openclaw-nova-demo" username. Humans get
// botMetadata.displayName when set (rare) or their username.
//
// Performance: one MongoDB User.find({_id: {$in: ids}}) lookup per
// call, even for the bulk path (we collect all reactor IDs across all
// messages and de-dup before the query). For a 50-message pod page
// with reactions on ~10 messages averaging 2 reactors each, that's
// at most 20 distinct user IDs — well under any latency budget.

import type { ReactionSummary } from '../models/pg/MessageReaction';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const User = require('../models/User');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolveAgentDisplayLabel } = require('./agentIdentityService');

export interface ReactionUser {
  id: string;
  username: string;
  displayName?: string;
}

// Decorated summary keeps the original count + mine flag and adds the
// resolved reactor list. We intentionally STRIP userIds from the
// outbound shape so the response is a flat consumer surface (the raw
// IDs leak nothing useful to clients and would force them to do their
// own lookup). Callers that need the raw IDs can still use the model
// directly.
export interface DecoratedReactionSummary {
  emoji: string;
  count: number;
  mine: boolean;
  users: ReactionUser[];
}

interface BotMeta {
  displayName?: string;
  instanceId?: string;
  agentName?: string;
}

interface LeanUser {
  _id: unknown;
  username?: string;
  botMetadata?: BotMeta;
}

function uniqueIds(summaries: ReactionSummary[]): string[] {
  const set = new Set<string>();
  for (const s of summaries) {
    for (const id of s.userIds) set.add(id);
  }
  return Array.from(set);
}

function loadUserMap(ids: string[]): Promise<Map<string, LeanUser>> {
  if (ids.length === 0) return Promise.resolve(new Map());
  return User.find({ _id: { $in: ids } })
    .select('username botMetadata')
    .lean()
    .then((rows: LeanUser[]) => {
      const map = new Map<string, LeanUser>();
      for (const u of rows) map.set(String(u._id), u);
      return map;
    });
}

function resolveDisplay(user: LeanUser | undefined, username: string): string | undefined {
  if (!user) return undefined;
  // For bots, prefer the curated agent-identity label (catches displayName
  // first, then humanized instanceId, with the runtime-leak guard inside
  // resolveAgentDisplayLabel). For humans, fall back to a plain displayName
  // when present — username already lives in the response shape.
  if (user.botMetadata) {
    const label: string = resolveAgentDisplayLabel(user, username);
    return label === username ? undefined : label;
  }
  return undefined;
}

export async function decorateReactionSummaries(
  summaries: ReactionSummary[],
): Promise<DecoratedReactionSummary[]> {
  const ids = uniqueIds(summaries);
  const userMap = await loadUserMap(ids);
  return summaries.map((s) => ({
    emoji: s.emoji,
    count: s.count,
    mine: s.mine,
    users: s.userIds.map((id) => {
      const u = userMap.get(id);
      const username = u?.username || 'unknown';
      const displayName = resolveDisplay(u, username);
      return displayName ? { id, username, displayName } : { id, username };
    }),
  }));
}

// Bulk path: decorate a Map<messageId, ReactionSummary[]> in-place.
// Single User lookup across all messages.
export async function decorateReactionMap(
  map: Map<string, ReactionSummary[]>,
): Promise<Map<string, DecoratedReactionSummary[]>> {
  const allSummaries: ReactionSummary[] = [];
  for (const list of map.values()) allSummaries.push(...list);
  const ids = uniqueIds(allSummaries);
  const userMap = await loadUserMap(ids);
  const out = new Map<string, DecoratedReactionSummary[]>();
  for (const [mid, summaries] of map) {
    out.set(
      mid,
      summaries.map((s) => ({
        emoji: s.emoji,
        count: s.count,
        mine: s.mine,
        users: s.userIds.map((id) => {
          const u = userMap.get(id);
          const username = u?.username || 'unknown';
          const displayName = resolveDisplay(u, username);
          return displayName ? { id, username, displayName } : { id, username };
        }),
      })),
    );
  }
  return out;
}

module.exports = { decorateReactionSummaries, decorateReactionMap };
module.exports.decorateReactionSummaries = decorateReactionSummaries;
module.exports.decorateReactionMap = decorateReactionMap;
