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

module.exports = isPodMember;

export {};
