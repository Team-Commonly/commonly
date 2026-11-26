import React from 'react';
import { Link } from 'react-router-dom';
import { Trans } from 'react-i18next';
import { daemonSetupCommandFor } from '../utils/daemonSetupCommand';

// F641: what a person reads when an operator revoked their computer's key and
// said why. The server sends a stable code (revokedReason), never text; a code
// this build does not know renders nothing, so the generic line stays.
export const hasDaemonRevokedReasonText = (reason: unknown): boolean => reason === 'cli_duplicate_daemons';

// The fix is the computer setup command. Where the page already shows it just
// below (commandBelow), the line points there; otherwise it links to Bring
// your own agent, which shows the command for such a computer.
const V2DaemonRevokedReason: React.FC<{ reason?: string | null; commandBelow?: boolean }> = ({ reason, commandBelow = false }) => {
  if (reason !== 'cli_duplicate_daemons') return null;
  return commandBelow
    ? <Trans i18nKey="agentManage.runtime.machineRevokedCliBugBelow" />
    : <Trans i18nKey="agentManage.runtime.machineRevokedCliBug" components={{ byo: <Link to="/v2/agents/byo" /> }} />;
};

// What the server keeps about the revoked computer: the OS its daemon last
// reported (Node's platform name; null from a CLI too old to say) and whether
// its owner opted out of the sandbox there ('unsandboxed-opted-in'); null when
// no daemon has reported it, as for a computer revoked before the field existed.
export interface RevokedComputerHost { platform?: string | null; unsandboxedOptIn?: boolean | null }

// F641: the setup line for THAT computer, not the browser's. On Windows it keeps
// the owner's choice: `daemon setup` without `--unsandboxed` turns an opt-in
// off, and with it turns one on. An unknown choice on Windows gets the line
// without the flag and a note saying how to keep an opt-in. With no OS on
// record, the browser's line, as every other surface gives it.
export const revokedComputerSetup = (
  host: RevokedComputerHost | null | undefined,
  fallbackOs: 'windows' | 'unix',
  apiUrl?: string,
): { command: string; keepsUnsandboxed: boolean; unsandboxedUnknown: boolean } => {
  if (!host?.platform) {
    return { command: daemonSetupCommandFor(fallbackOs, apiUrl), keepsUnsandboxed: false, unsandboxedUnknown: false };
  }
  const windows = host.platform === 'win32';
  const keepsUnsandboxed = windows && host.unsandboxedOptIn === true;
  const unsandboxedUnknown = windows && typeof host.unsandboxedOptIn !== 'boolean';
  return {
    command: daemonSetupCommandFor(windows ? 'windows' : 'unix', apiUrl, { unsandboxed: keepsUnsandboxed }),
    keepsUnsandboxed,
    unsandboxedUnknown,
  };
};

// The flag's cost, next to a line that carries it to keep an opt-in.
export const V2KeepsUnsandboxedNote: React.FC = () => (
  <Trans i18nKey="agentManage.runtime.keepsUnsandboxed" components={{ cmd: <code /> }} />
);

// The choice is unknown: say how to keep an opt-in, without assuming one.
export const V2UnsandboxedUnknownNote: React.FC = () => (
  <Trans i18nKey="agentManage.runtime.unsandboxedUnknown" components={{ cmd: <code /> }} />
);

export default V2DaemonRevokedReason;
