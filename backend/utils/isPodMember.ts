// Membership predicate for pod-scoped WRITES. Deliberately strict: it does
// not carry the admin bypass `DMService.canViewPod` has, because that bypass
// exists for read observability and would make "only members can write here"
// untrue for the one account most able to do damage by accident.
//
// The rule the pod's own write paths implement, and nothing else: `createMessage`
// (controllers/messageController.ts) and the socket post path (server.ts) both
// check `pod.members` alone. A connector that admits a writer those two refuse
// is more permissive than the pod it writes into, which is what TASK-161
// measured: `createdBy` keeps the creator's id after `leavePod` filters
// `members`, so a departed creator was refused by the app and relayed anyway.
//
// TASK-170: this module no longer exports a second, creator-inclusive rule.
// It used to export one twice (`module.exports = isPodMember` and a named
// `isPodMember`), so the obvious spelling `require('./utils/isPodMember')` bound
// the permissive one — TASK-165's M2 mutation is exactly that edit, and it stayed
// green. After TASK-166 nothing in production called it (8 binders, all
// destructuring `isListedPodMember`), so it is deleted rather than renamed: the
// clause answered "is this someone `Pod.members` forgot to list", a creation-time
// false negative that `Pod`'s pre-save hook already covers, and a live-looking
// function with no caller is one import away from being reached for again.
// See `__tests__/unit/utils/isPodMember.test.js` — the module has no callable
// default, and that is asserted rather than assumed.
const isListedPodMember = (pod: any, userId: unknown): boolean => {
  if (!pod || !userId) return false;
  const id = String(userId);
  return (pod.members || []).some((m: any) => (
    (m?._id?.toString?.() || m?.toString?.() || '') === id
  ));
};

module.exports = { isListedPodMember };

export {};
