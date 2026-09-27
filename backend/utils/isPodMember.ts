// Membership predicate for pod-scoped WRITES. Deliberately strict: it does
// not carry the admin bypass `DMService.canViewPod` has, because that bypass
// exists for read observability and would make "only members can write here"
// untrue for the one account most able to do damage by accident.
//
// The creator counts as a member — `Pod.members` does not always list them.
const isPodMember = (pod: any, userId: unknown): boolean => {
  if (!pod || !userId) return false;
  const id = String(userId);
  if (pod.createdBy?.toString?.() === id) return true;
  return (pod.members || []).some((m: any) => (
    (m?._id?.toString?.() || m?.toString?.() || '') === id
  ));
};

// The membership rule the pod's own write paths implement, and nothing else:
// `createMessage` (controllers/messageController.ts) and the socket post path
// (server.ts) both check `pod.members` alone. A connector that admits a writer
// those two refuse is more permissive than the pod it writes into, which is what
// TASK-161 measured: `createdBy` keeps the creator's id after `leavePod` filters
// `members`, so a departed creator was refused by the app and relayed anyway.
//
// Named for the mechanism, not for emphasis. The creator clause above answers
// "is this someone `Pod.members` forgot to list" — a false negative at creation
// time — and was never a ruling that leaving leaves membership intact.
const isListedPodMember = (pod: any, userId: unknown): boolean => {
  if (!pod || !userId) return false;
  const id = String(userId);
  return (pod.members || []).some((m: any) => (
    (m?._id?.toString?.() || m?.toString?.() || '') === id
  ));
};

module.exports = isPodMember;
module.exports.isPodMember = isPodMember;
module.exports.isListedPodMember = isListedPodMember;

export {};
