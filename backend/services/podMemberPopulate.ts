// Historical DM membership survives account deletion. Mongoose normally drops
// missing User refs from populated arrays; keep the opaque id and a safe label
// so every pod read preserves the pair without reviving the deleted account.
export const podMemberPopulate = (select: string) => ({
  path: 'members',
  select,
  transform: (member: unknown, id: unknown) => member || {
    _id: id, username: 'Deleted user', profilePicture: null, isBot: false,
  },
});
