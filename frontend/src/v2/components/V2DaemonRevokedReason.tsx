import React from 'react';
import { Link } from 'react-router-dom';
import { Trans } from 'react-i18next';

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

export default V2DaemonRevokedReason;
