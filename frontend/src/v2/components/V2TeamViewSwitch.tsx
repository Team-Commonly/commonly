import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import V2Segmented from './V2Segmented';

type TeamView = 'agents' | 'health';
const PATHS: Record<TeamView, string> = { agents: '/v2/agents', health: '/v2/agents/health' };

/** Your team's two views, beside the page title (D115 frame). */
const V2TeamViewSwitch: React.FC<{ value: TeamView }> = ({ value }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <V2Segmented<TeamView>
      size="sm"
      className="v2-team__views"
      ariaLabel={t('agentHealth.viewsAria')}
      value={value}
      onChange={(next) => navigate(PATHS[next])}
      options={[
        { value: 'agents', label: t('agentHealth.views.agents') },
        { value: 'health', label: t('agentHealth.views.health') },
      ]}
    />
  );
};

export default V2TeamViewSwitch;
