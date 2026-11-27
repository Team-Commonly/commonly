// F662: a claude or codex run loop refuses or warns on a turn someone other
// than the agent's owner started (lib/account-use-guard.js). Suites about other
// behaviour serve their events as the owner's, stamped the way a current
// server stamps them, so the guard runs them with no extra read or notice.
export const OWNER_ACCOUNT_USE = Object.freeze({
  v: 1,
  ownerUserId: 'owner-of-this-agent',
  ownerName: 'owner',
  requesterUserIds: ['owner-of-this-agent'],
  requesterKind: 'human',
  requesterSharesTeamPod: null,
  pod: { type: 'chat', publicRead: false, communityListed: false, joinPolicy: 'invite-only' },
});

export const ownerStamped = (event) => (event && typeof event === 'object' ? {
  ...event,
  payload: { accountUse: OWNER_ACCOUNT_USE, ...(event.payload || {}) },
} : event);

export const ownerStampedAll = (events) => (Array.isArray(events) ? events.map(ownerStamped) : events);
