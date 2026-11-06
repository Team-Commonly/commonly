// F221: GitHub's install page opens on "All repositories", so a click-through
// gives Commonly Connect every repo. The choice and what it costs sit with the
// link that opens that page, not earlier in the flow.
import React from 'react';
import { useTranslation } from 'react-i18next';

interface GithubInstallWarningProps {
  /** The link to the install page. */
  children: React.ReactNode;
  role?: string;
}

const GithubInstallWarning: React.FC<GithubInstallWarningProps> = ({ children, role }) => {
  const { t } = useTranslation();
  return (
    <div className="v2-cx-warning" role={role}>
      <strong>{t('connectors.hostedMcpAccessNext', { defaultValue: "On GitHub, choose 'Only select repositories'." })}</strong>
      <p>
        {t('connectors.hostedMcpAccessAll', {
          defaultValue: "GitHub's install page opens on All repositories. Leave it there and Commonly Connect can reach every repository on that account or org, including new ones. Public repos are always readable.",
        })}
      </p>
      <p>{children}</p>
    </div>
  );
};

export default GithubInstallWarning;
