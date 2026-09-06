import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import ViewKanbanOutlinedIcon from '@mui/icons-material/ViewKanbanOutlined';
import NotificationsNoneOutlinedIcon from '@mui/icons-material/NotificationsNoneOutlined';
import PersonOutlineIcon from '@mui/icons-material/PersonOutline';

interface V2MobileTabsProps {
  podId: string | null;
  needsYouCount: number;
  onOpenInspector: () => void;
}

/** Phone-only workspace navigation. Desktop keeps the persistent rail. */
const V2MobileTabs: React.FC<V2MobileTabsProps> = ({ podId, needsYouCount, onOpenInspector }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const goToPod = (suffix = '') => {
    if (podId) navigate(`/v2/pods/${podId}${suffix}`);
  };

  return (
    <nav className="v2-mobile-tabs" aria-label={t('common.nav.pods')}>
      <button type="button" className="v2-mobile-tabs__item v2-mobile-tabs__item--active" onClick={() => goToPod()} aria-label={t('common.nav.pods')}>
        <ChatBubbleOutlineIcon fontSize="small" aria-hidden="true" />
      </button>
      <button type="button" className="v2-mobile-tabs__item" onClick={() => goToPod('/board')} aria-label="Board" disabled={!podId}>
        <ViewKanbanOutlinedIcon fontSize="small" aria-hidden="true" />
      </button>
      <button type="button" className="v2-mobile-tabs__item" onClick={onOpenInspector} aria-label="Needs you" disabled={!podId}>
        <NotificationsNoneOutlinedIcon fontSize="small" aria-hidden="true" />
        {needsYouCount > 0 && <span className="v2-mobile-tabs__badge">{needsYouCount}</span>}
      </button>
      <button type="button" className="v2-mobile-tabs__item" onClick={() => navigate('/v2/settings')} aria-label={t('common.nav.settings')}>
        <PersonOutlineIcon fontSize="small" aria-hidden="true" />
      </button>
    </nav>
  );
};

export default V2MobileTabs;
