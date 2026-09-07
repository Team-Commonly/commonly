import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

interface V2MobileTabsProps {
  // Total needs-you count for the person, not one pod's. Rendered inline in
  // the label ("Needs you · 3") so the phone carries one counter, same as the
  // rail badge and the inspector.
  needsYouCount: number;
}

const Icon = ({ d }: { d: string }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

/** Phone-only navigation: Pods · Needs you · Team · Settings, each with a label. */
const V2MobileTabs: React.FC<V2MobileTabsProps> = ({ needsYouCount }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const needsYouLabel = needsYouCount > 0
    ? `${t('common.nav.needsYou')} · ${needsYouCount}`
    : t('common.nav.needsYou');
  const tiles = [
    { key: 'pods', label: t('common.nav.pods'), path: '/v2', active: pathname === '/v2' || pathname.startsWith('/v2/pods'), icon: 'M3 7l9-4 9 4-9 4-9-4zM3 12l9 4 9-4M3 17l9 4 9-4' },
    { key: 'needs-you', label: needsYouLabel, path: '/v2/activity', active: pathname.startsWith('/v2/activity'), icon: 'M22 12h-4l-3 9-6-18-3 9H2' },
    { key: 'team', label: t('common.nav.team'), path: '/v2/agents', active: pathname.startsWith('/v2/agents'), icon: 'M12 1v6m0 8v6M5 5l4 4M15 15l4 4M1 12h6m8 0h6M5 19l4-4M15 9l4-4' },
    { key: 'settings', label: t('common.nav.settings'), path: '/v2/settings', active: pathname.startsWith('/v2/settings'), icon: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12a7 7 0 00-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 00-2-1.2L14 3h-4l-.5 2.6a7 7 0 00-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 005 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 002 1.2L10 21h4l.5-2.6a7 7 0 002-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z' },
  ];

  return (
    <nav className="v2-mobile-tabs" aria-label={t('common.nav.pods')}>
      {tiles.map((tile) => (
        <button
          key={tile.key}
          type="button"
          className={`v2-mobile-tabs__item${tile.active ? ' v2-mobile-tabs__item--active' : ''}`}
          onClick={() => navigate(tile.path)}
          aria-current={tile.active ? 'page' : undefined}
        >
          <span className="v2-mobile-tabs__icon"><Icon d={tile.icon} /></span>
          <span className="v2-mobile-tabs__label">{tile.label}</span>
        </button>
      ))}
    </nav>
  );
};

export default V2MobileTabs;
