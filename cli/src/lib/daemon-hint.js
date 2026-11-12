// The hint a foreground `commonly agent run` prints for keeping the agent
// running. The daemon supervises only the agents placed on this computer, so
// the hint depends on whether a daemon is registered here at all.
//
// The two daemon steps depend on each other, so on Windows they print one per
// line instead of joined with `&&`, which Windows PowerShell 5.1 lacks (F435).
import { cliName, cliSteps } from './cli-hint.js';

export const foregroundDaemonHint = ({ daemonRegistered, platform = process.platform }) => {
  const lead = 'foreground mode; this stops when the terminal closes. To keep it running, ';
  const inWebApp = 'the web app: Agents → Bring your own → On my computer';
  if (daemonRegistered) return `${lead}add the agent to this computer in ${inWebApp}`;
  const cli = cliName(platform);
  const steps = cliSteps([`${cli} daemon register`, `${cli} daemon install`], { platform, indent: '    ' });
  return platform === 'win32'
    ? `${lead}add this computer by running these two commands, one after the other:${steps}\n  then add the agent to it in ${inWebApp}`
    : `${lead}add this computer with: ${steps}, then add the agent to it in ${inWebApp}`;
};
