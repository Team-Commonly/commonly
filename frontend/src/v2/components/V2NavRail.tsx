import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import V2Avatar from './V2Avatar';
import { useAuth } from '../../context/AuthContext';

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

const NAV_ITEMS: NavItem[] = [
  { key: 'pods', label: 'Pods', path: '/v2', icon: <Icon d="M3 7l9-4 9 4-9 4-9-4zM3 12l9 4 9-4M3 17l9 4 9-4" /> },
  { key: 'feed', label: 'Feed', path: '/v2/feed', icon: <Icon d="M3 5h18M3 12h18M3 19h18" /> },
  { key: 'activity', label: 'Activity', path: '/v2/activity', icon: <Icon d="M4 4h16v12H5.5L4 17.5V4zM8 9h8M8 13h5" />, dividerAfter: true },
  { key: 'agents', label: 'Agents', path: '/v2/agents', icon: <Icon d="M12 1v6m0 8v6M5 5l4 4M15 15l4 4M1 12h6m8 0h6M5 19l4-4M15 9l4-4" /> },
  { key: 'skills', label: 'Skills', path: '/v2/skills', icon: <Icon d="M12 3l2.2 4.5 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L4.8 8.2l5-.7L12 3z" /> },
  { key: 'marketplace', label: 'Apps', path: '/v2/marketplace', icon: <Icon d="M3 3l3 9h12l3-9M5 12l1 8h12l1-8M9 16h6" />, dividerAfter: true },
  { key: 'digest', label: 'Digest', path: '/v2/digest', icon: <Icon d="M4 4h16v16H4zM8 8h8M8 12h8M8 16h5" /> },
  { key: 'analytics', label: 'Analytics', path: '/v2/analytics', icon: <Icon d="M3 3v18h18M7 14l3-3 3 3 5-5" /> },
  { key: 'settings', label: 'Settings', path: '/v2/settings', icon: <Icon d="M12 15a3 3 0 100-6 3 3 0 000 6zM19 12a7 7 0 00-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 00-2-1.2L14 3h-4l-.5 2.6a7 7 0 00-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 005 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 002 1.2L10 21h4l.5-2.6a7 7 0 002-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z" /> },
];

const V2NavRail: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { currentUser, logout } = useAuth();

  const isActive = (item: NavItem): boolean => {
    if (item.path === '/v2') {
      return location.pathname === '/v2' || location.pathname.startsWith('/v2/pods');
    }
    return location.pathname.startsWith(item.path);
  };

  return (
    <aside className="v2-pane v2-pane--rail">
      <div className="v2-rail">
        <div className="v2-rail__brand">
          <span className="v2-rail__brand-icon">c</span>
          <span>commonly</span>
        </div>

        <nav className="v2-rail__nav" aria-label="v2 navigation">
          {NAV_ITEMS.map((item) => (
            <React.Fragment key={item.key}>
              <button
                type="button"
                className={`v2-rail__item${isActive(item) ? ' v2-rail__item--active' : ''}`}
                onClick={() => navigate(item.path)}
                title={item.label}
                data-label={item.label}
              >
                <span className="v2-rail__item-icon">{item.icon}</span>
                <span className="v2-rail__item-label">{item.label}</span>
              </button>
              {item.dividerAfter && <span className="v2-rail__divider" aria-hidden="true" />}
            </React.Fragment>
          ))}
        </nav>

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
            className="v2-inspector__more-btn"
            onClick={logout}
            title="Sign out"
          >
            <Icon d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" />
          </button>
        </div>
      </div>
    </aside>
  );
};

export default V2NavRail;
