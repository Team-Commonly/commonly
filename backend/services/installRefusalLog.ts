/**
 * One searchable line for each install or start a person is refused, so a
 * refusal can be traced afterwards. Grep `[install-refused]`. Ids and counts
 * only, and JSON keeps a typed agent name on one line.
 */
export const logInstallRefusal = (
  route: string,
  code: string,
  fields: {
    userId: unknown;
    agentName?: unknown;
    instanceId?: unknown;
    podId?: unknown;
    used?: unknown;
    cap?: unknown;
  },
): void => {
  console.warn(`[install-refused] ${JSON.stringify({
    code,
    route,
    ...fields,
    userId: String(fields.userId),
  })}`);
};
