import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import V2Avatar from './V2Avatar';
import V2FeedbackMenu from './V2FeedbackMenu';
import V2LangSwitch from './V2LangSwitch';
import { useAuth } from '../../context/AuthContext';
import { useTranslation } from 'react-i18next';

interface NavItem {
  key: string;
  label: string;
  path: string;
  icon: React.ReactNode;
  dividerAfter?: boolean;
}

const Icon = ({ d }: { d: string }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

// Trimmed for YC demo path (2026-04-29): Pods · Agents · Community · Settings.
// Routes for Feed, Activity, Skills, Digest, Analytics still resolve — they
// just aren't reachable from the rail. Re-add when the surface earns its slot.
const NAV_ITEMS: NavItem[] = [
  { key: 'pods', label: 'Pods', path: '/v2', icon: <Icon d="M3 7l9-4 9 4-9 4-9-4zM3 12l9 4 9-4M3 17l9 4 9-4" /> },
  { key: 'agents', label: 'Agents', path: '/v2/agents', icon: <Icon d="M12 1v6m0 8v6M5 5l4 4M15 15l4 4M1 12h6m8 0h6M5 19l4-4M15 9l4-4" /> },
  { key: 'community', label: 'Community', path: '/v2/community', icon: <Icon d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8M22 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" /> },
  // 'Apps' (marketplace) removed from the rail while the marketplace is behind
  // its "coming soon" wall — a nav item that only leads to a coming-soon page
  // is a dead end. Restore this entry when MARKETPLACE_LOCKED is lifted.
  { key: 'settings', label: 'Settings', path: '/v2/settings', icon: <Icon d="M12 15a3 3 0 100-6 3 3 0 000 6zM19 12a7 7 0 00-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 00-2-1.2L14 3h-4l-.5 2.6a7 7 0 00-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 005 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 002 1.2L10 21h4l.5-2.6a7 7 0 002-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z" /> },
];

interface V2NavRailProps {
  // On phones (<=760px) the pods sidebar collapses to a slide-over drawer.
  // When provided, tapping "Pods" opens that drawer instead of navigating to
  // /v2 (which auto-redirects into the first pod and dead-ends the user in a
  // single chat with no way back to the list). Undefined on surfaces without a
  // drawer (feature pages) — those fall back to plain navigation.
  onPodsMobileNav?: () => void;
}

const isMobileViewport = (): boolean => (
  typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 760px)').matches
);

const V2NavRail: React.FC<V2NavRailProps> = ({ onPodsMobileNav }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { currentUser, logout } = useAuth();
  const { t } = useTranslation();
  // Labels resolve at render so the rail tooltip (v2.css attr(data-label))
  // follows the active locale — NAV_ITEMS.label is the English fallback.
  const navLabel = (item: NavItem) => t(`common.nav.${item.key}`, { defaultValue: item.label });
  const visibleNavItems = NAV_ITEMS.filter(
    (item) => item.key !== 'community' || Boolean(process.env.REACT_APP_COMMUNITY_POD_ID),
  );

  const isActive = (item: NavItem): boolean => {
    if (item.path === '/v2') {
      return location.pathname === '/v2' || location.pathname.startsWith('/v2/pods');
    }
    return location.pathname.startsWith(item.path);
  };

  const handleNavClick = (item: NavItem) => {
    if (item.key === 'pods' && onPodsMobileNav && isMobileViewport()) {
      onPodsMobileNav();
      return;
    }
    navigate(item.path);
  };

  return (
    <aside className="v2-pane v2-pane--rail">
      <div className="v2-rail">
        <div className="v2-rail__brand">
          <span className="v2-rail__brand-icon" aria-label="Commonly">
            <svg width="18" height="18" viewBox="0 0 64 64" fill="none" aria-hidden="true">
              <path d="M 50 17.7 A 22 22 0 1 0 50 46.3" stroke="currentColor" strokeWidth="9" strokeLinecap="round" />
              <circle cx="25" cy="32" r="2.4" fill="currentColor" />
              <circle cx="32" cy="32" r="2.4" fill="currentColor" />
              <circle cx="39" cy="32" r="2.4" fill="currentColor" />
            </svg>
          </span>
          <span>commonly</span>
        </div>

        <nav className="v2-rail__nav" aria-label="v2 navigation">
          {visibleNavItems.map((item) => (
            <React.Fragment key={item.key}>
              <button
                type="button"
                className={`v2-rail__item${isActive(item) ? ' v2-rail__item--active' : ''}`}
                onClick={() => handleNavClick(item)}
                title={navLabel(item)}
                data-label={navLabel(item)}
              >
                <span className="v2-rail__item-icon">{item.icon}</span>
                <span className="v2-rail__item-label">{navLabel(item)}</span>
              </button>
              {item.dividerAfter && <span className="v2-rail__divider" aria-hidden="true" />}
            </React.Fragment>
          ))}
        </nav>

        <div className="v2-rail__foot">
          {/* Help & preferences — language switch + the help/feedback menu
              (Sam 2026-07-23: the guide moved into the feedback menu next to
              report-a-bug / request-a-feature; language switch lives here too,
              off its old cramped above-the-logo slot). */}
          <div className="v2-rail__utility">
            <V2LangSwitch />
            <V2FeedbackMenu />
          </div>
          <span className="v2-rail__foot-sep" aria-hidden="true" />
          {/* Account */}
          <div className="v2-rail__user">
            <V2Avatar name={currentUser?.username || 'You'} size="md" online />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="v2-rail__user-name" style={{
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}
              >
                {currentUser?.username || 'You'}
              </div>
              <div className="v2-rail__user-status">
                <span className="v2-online-dot" />
                Online
              </div>
            </div>
            <button
              type="button"
              className="v2-rail__signout"
              onClick={logout}
              title="Sign out"
            >
              <Icon d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
};

export default V2NavRail;
