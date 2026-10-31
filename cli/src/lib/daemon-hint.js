// The hint a foreground `commonly agent run` prints for keeping the agent
// running. The daemon supervises only the agents placed on this computer, so
// the hint depends on whether a daemon is registered here at all.
export const foregroundDaemonHint = ({ daemonRegistered }) => (daemonRegistered
  ? 'foreground mode; this stops when the terminal closes. To keep it running, add the agent to this computer in the web app: Agents → Bring your own → On my computer'
  : 'foreground mode; this stops when the terminal closes. To keep it running, add this computer with: commonly daemon register && commonly daemon install, then add the agent to it in the web app: Agents → Bring your own → On my computer');
