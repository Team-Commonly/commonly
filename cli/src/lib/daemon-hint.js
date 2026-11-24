// The hint a foreground `commonly agent run` prints for keeping the agent
// running. The daemon supervises only the agents placed on this computer, so
// the hint depends on whether a daemon is registered here at all.
//
// The two daemon steps depend on each other, so on Windows they print one per
// line instead of joined with `&&`, which Windows PowerShell 5.1 lacks (F435).
//
// Run from npx's cache (F570: the Bring your own page's line), `daemon
// install` would pin the service to a folder npm can clear, so the hint names
// the one line that installs a stable copy first (`daemon setup`, F370).
import { cliName, cliSteps, npxName, runsFromNpxCache } from './cli-hint.js';

export const foregroundDaemonHint = ({
  daemonRegistered, platform = process.platform, entry = process.argv[1], instanceUrl = null,
}) => {
  const lead = 'foreground mode; this stops when the terminal closes. To keep it running, ';
  const inWebApp = 'the web app: Agents → Bring your own → On my computer';
  if (daemonRegistered) return `${lead}add the agent to this computer in ${inWebApp}`;
  if (runsFromNpxCache(entry)) {
    const setup = `${npxName(platform)} -y @commonlyai/cli@latest daemon setup`
      + `${instanceUrl ? ` --instance ${instanceUrl}` : ''}${platform === 'win32' ? ' --unsandboxed' : ''}`;
    return `${lead}add this computer once with: ${setup}\n  then add the agent to it in ${inWebApp}`;
  }
  const cli = cliName(platform, { entry });
  const steps = cliSteps([`${cli} daemon register`, `${cli} daemon install`], { platform, indent: '    ' });
  return platform === 'win32'
    ? `${lead}add this computer by running these two commands, one after the other:${steps}\n  then add the agent to it in ${inWebApp}`
    : `${lead}add this computer with: ${steps}, then add the agent to it in ${inWebApp}`;
};
