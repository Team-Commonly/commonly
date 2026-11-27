/**
 * Copy for the stalled-connect row (W4 item 3, F666).
 *
 * Until F666 this file composed a message the agent posted into the pod: the
 * installer's name, what they had copied, their OS, and the exact start
 * command. It was addressed to one person and read by every member. The ask is
 * now the installer's private Activity row, and the command stays where it
 * already lives for them alone: the agent's panel (the inspector's control
 * section and the composer warning, both gated to the owner by
 * `deriveAgentState`). So this copy names the agent and points there; it never
 * carries a command.
 *
 * Flat voice, no hedge: the row is only written for `never-connected`, which is
 * structurally certain (no token was ever used to listen).
 *
 * English only, like the rest of the server's attention rows: the language
 * lives in the browser and never reaches the backend.
 */
export const composeStalledConnectNotice = ({
  displayName, connectable = false,
}: {
  displayName: string;
  /** Made on the page: its key is on no computer, so its panel offers Connect. */
  connectable?: boolean;
}): { title: string; detail: string } => ({
  title: `${displayName} hasn't connected yet`,
  detail: connectable
    ? `Nothing is running ${displayName}, so it can't answer anyone in this Pod. `
      + 'Open the Pod, click the agent, and press Connect in its panel to get the command for your computer.'
    : `Nothing is running ${displayName}, so it can't answer anyone in this Pod. `
      + 'Open the Pod and click the agent: its panel has the command that starts it.',
});

export default { composeStalledConnectNotice };
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
