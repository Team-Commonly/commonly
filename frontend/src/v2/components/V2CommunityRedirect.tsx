import React from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

const V2CommunityRedirect: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();

  React.useEffect(() => {
    const communityPodId = process.env.REACT_APP_COMMUNITY_POD_ID || '';
    const communityInviteToken = process.env.REACT_APP_COMMUNITY_INVITE_TOKEN || '';
    let cancelled = false;

    if (!communityPodId) {
      navigate('/v2', { replace: true });
      return undefined;
    }

    axios.get(`/api/pods/${communityPodId}`)
      .then(() => {
        if (!cancelled) {
          navigate(`/v2/pods/${communityPodId}`, { replace: true });
        }
      })
      .catch(() => {
        if (!cancelled) {
          navigate(`/v2/invite/${communityInviteToken}`, { replace: true });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [navigate]);

  return (
    <div className="v2-empty" role="status">
      <div className="v2-empty__title">{t('common.communityRedirect.title')}</div>
      <div className="v2-empty__text">{t('common.communityRedirect.text')}</div>
    </div>
  );
};

export default V2CommunityRedirect;
