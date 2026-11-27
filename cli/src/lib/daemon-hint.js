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

const IN_WEB_APP = 'the web app: Agents → Bring your own → On my computer';

// What to do to keep the agent running, starting lowercase so it can follow
// "To keep it running, ". Both the start-time hint and the first-answer notice
// (F642) end with it.
export const keepRunningStep = ({
  daemonRegistered, platform = process.platform, entry = process.argv[1], instanceUrl = null,
}) => {
  if (daemonRegistered) return `add the agent to this computer in ${IN_WEB_APP}`;
  if (runsFromNpxCache(entry)) {
    const setup = `${npxName(platform)} -y @commonlyai/cli@latest daemon setup`
      + `${instanceUrl ? ` --instance ${instanceUrl}` : ''}${platform === 'win32' ? ' --unsandboxed' : ''}`;
    return `add this computer once with: ${setup}\n  then add the agent to it in ${IN_WEB_APP}`;
  }
  const cli = cliName(platform, { entry });
  const steps = cliSteps([`${cli} daemon register`, `${cli} daemon install`], { platform, indent: '    ' });
  return platform === 'win32'
    ? `add this computer by running these two commands, one after the other:${steps}\n  then add the agent to it in ${IN_WEB_APP}`
    : `add this computer with: ${steps}, then add the agent to it in ${IN_WEB_APP}`;
};

export const foregroundDaemonHint = (args) => (
  `foreground mode; this stops when the terminal closes. To keep it running, ${keepRunningStep(args)}`
);

// F642: the moment a foreground run first answers someone is when the person
// has just seen it work, so that is when the keep-it-running step is worth
// repeating. Returns the callback `performRun` calls after each turn that
// answered a person; it prints at most once per process, and never for a run
// the daemon already supervises. `hintArgs` is read at print time, so a daemon
// registered while this run was up is named correctly.
export const createFirstAnswerNotice = ({ managed, hintArgs, log }) => {
  let printed = false;
  return () => {
    if (printed || managed) return;
    printed = true;
    const text = 'Your agent just answered. This foreground run stops when the terminal closes.\n'
      + `  To keep it running, ${keepRunningStep(hintArgs())}`;
    for (const line of text.split('\n')) log(line);
  };
};
