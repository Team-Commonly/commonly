import React from 'react';
import { useLocation } from 'react-router-dom';
import {
    List, ListItemButton, ListItemIcon, ListItemText, Typography,
    Avatar, Divider, Box, Skeleton, IconButton, useMediaQuery, useTheme
} from '@mui/material';
import {
    Home as HomeIcon,
    Person as PersonIcon,
    ExitToApp as LogoutIcon,
    Chat as ChatIcon,
    ChevronLeft as ChevronLeftIcon,
    Email as EmailIcon,
    SmartToy as AgentsIcon,
    Forum as ForumIcon,
    Timeline as ActivityIcon,
    Apps as AppsIcon,
    AutoAwesome as SkillsIcon,
    AdminPanelSettings as AdminIcon,
} from '@mui/icons-material';
import { getAvatarColor, getAvatarSrc } from '../utils/avatarUtils';
import { useAppContext } from '../context/AppContext';
import { useLayout } from '../context/LayoutContext';
import { useV2Embedded } from '../v2/hooks/useV2Embedded';
import './Dashboard.css';

const Dashboard: React.FC = () => {
    const { currentUser, userLoading, refreshData } = useAppContext();
    const { isDashboardCollapsed, toggleDashboard } = useLayout();
    const location = useLocation();
    const theme = useTheme();
    const isMobile = useMediaQuery(theme.breakpoints.down('md'));
    const v2Embedded = useV2Embedded();

    // Inside the v2 shell V2NavRail already owns navigation, so any
    // dashboard nav target is rewritten to /v2 and routed via SPA navigation
    // instead of a full page reload that would push the user out of v2.
    const handleNavigation = (path: string): void => {
        refreshData();

        if (isMobile && !isDashboardCollapsed) {
            toggleDashboard();
        }

        if (v2Embedded) {
            const v2Path = path.startsWith('/v2') ? path : `/v2${path}`;
            window.history.pushState({}, '', v2Path);
            window.dispatchEvent(new PopStateEvent('popstate'));
            return;
        }
        window.location.href = path;
    };

    if (v2Embedded) {
        const shortcuts: Array<{ label: string; path: string; Icon: React.ComponentType }> = [
            { label: 'Pods', path: '/v2/pods', Icon: ChatIcon },
            { label: 'Feed', path: '/v2/feed', Icon: HomeIcon },
            { label: 'Activity', path: '/v2/activity', Icon: ActivityIcon },
            { label: 'Agents', path: '/v2/agents', Icon: AgentsIcon },
            { label: 'Skills', path: '/v2/skills', Icon: SkillsIcon },
            { label: 'Apps', path: '/v2/apps', Icon: AppsIcon },
            { label: 'Daily Digest', path: '/v2/digest', Icon: EmailIcon },
            { label: 'Profile', path: '/v2/profile', Icon: PersonIcon },
        ];
        return (
            <Box sx={{ display: 'grid', gap: 16, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', md: 'repeat(4, 1fr)' } }}>
                {shortcuts.map(({ label, path, Icon }) => (
                    <Box
                        key={path}
                        role="button"
                        tabIndex={0}
                        onClick={() => handleNavigation(path)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                handleNavigation(path);
                            }
                        }}
                        sx={{
                            border: '1px solid var(--v2-border, #e5e7eb)',
                            borderRadius: '12px',
                            padding: '16px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 1.5,
                            background: 'var(--v2-surface, #fff)',
                            cursor: 'pointer',
                            transition: 'background 120ms ease, border-color 120ms ease',
                            '&:hover': {
                                background: 'var(--v2-surface-hover, #f1f2f5)',
                                borderColor: 'var(--v2-border-strong, #d7dce7)',
                            },
                        }}
                    >
                        <Icon />
                        <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>{label}</Typography>
                    </Box>
                ))}
            </Box>
        );
    }

    return (
        <div className={`dashboard ${isDashboardCollapsed ? 'collapsed' : ''}`}>
            <Box className="dashboard-header">
                {!isDashboardCollapsed && (
                    <Box className="user-profile">
                        {userLoading ? (
                            <>
                                <Skeleton variant="circular" width={64} height={64} sx={{ mb: 1 }} />
                                <Skeleton variant="text" width={120} height={32} sx={{ mb: 0.5 }} />
                                <Skeleton variant="text" width={180} height={24} />
                            </>
                        ) : currentUser ? (
                            <>
                                <Avatar
                                    sx={{
                                        width: 64,
                                        height: 64,
                                        mb: 1,
                                        bgcolor: getAvatarColor(currentUser.profilePicture),
                                        cursor: 'pointer'
                                    }}
                                    src={getAvatarSrc(currentUser.profilePicture)}
                                    onClick={toggleDashboard}
                                >
                                    {currentUser.username.charAt(0).toUpperCase()}
                                </Avatar>
                                <Typography variant="h6" sx={{ fontWeight: 'bold', mb: 0.5 }}>
                                    {currentUser.username}
                                </Typography>
                                <Typography variant="body2" color="textSecondary" sx={{ mb: 2, textAlign: 'center' }}>
                                    {currentUser.email}
                                </Typography>
                            </>
                        ) : null}
                    </Box>
                )}

                {isDashboardCollapsed && (
                    <IconButton
                        onClick={toggleDashboard}
                        sx={{
                            my: 1,
                            color: 'primary.main'
                        }}
                    >
                        <ChevronLeftIcon />
                    </IconButton>
                )}
            </Box>

            <Divider />

            <List component="nav">
                <ListItemButton
                    onClick={() => handleNavigation('/feed')}
                    selected={location.pathname === '/feed'}
                >
                    <ListItemIcon>
                        <HomeIcon />
                    </ListItemIcon>
                    <ListItemText primary="Feed" />
                </ListItemButton>

                <ListItemButton
                    onClick={() => handleNavigation('/profile')}
                    selected={location.pathname === '/profile'}
                >
                    <ListItemIcon>
                        <PersonIcon />
                    </ListItemIcon>
                    <ListItemText primary="Profile" />
                </ListItemButton>

                <ListItemButton
                    onClick={() => handleNavigation('/digest')}
                    selected={location.pathname === '/digest'}
                >
                    <ListItemIcon>
                        <EmailIcon />
                    </ListItemIcon>
                    <ListItemText primary="Daily Digest" />
                </ListItemButton>

                <ListItemButton
                    onClick={() => handleNavigation('/pods')}
                    selected={location.pathname.startsWith('/pods') && !location.pathname.includes('agent-admin')}
                >
                    <ListItemIcon>
                        <ChatIcon />
                    </ListItemIcon>
                    <ListItemText primary="Pods" />
                </ListItemButton>
                <ListItemButton
                    onClick={() => handleNavigation('/pods/agent-admin')}
                    selected={location.pathname === '/pods/agent-admin'}
                >
                    <ListItemIcon>
                        <ForumIcon />
                    </ListItemIcon>
                    <ListItemText primary="Agent Admin" />
                </ListItemButton>

                <ListItemButton
                    onClick={() => handleNavigation('/agents')}
                    selected={location.pathname === '/agents'}
                >
                    <ListItemIcon>
                        <AgentsIcon />
                    </ListItemIcon>
                    <ListItemText primary="Agents" />
                </ListItemButton>

                <ListItemButton
                    onClick={() => handleNavigation('/skills')}
                    selected={location.pathname === '/skills'}
                >
                    <ListItemIcon>
                        <SkillsIcon />
                    </ListItemIcon>
                    <ListItemText primary="Skills" />
                </ListItemButton>

                <ListItemButton
                    onClick={() => handleNavigation('/apps')}
                    selected={location.pathname === '/apps'}
                >
                    <ListItemIcon>
                        <AppsIcon />
                    </ListItemIcon>
                    <ListItemText primary="Apps" />
                </ListItemButton>

                <ListItemButton
                    onClick={() => handleNavigation('/activity')}
                    selected={location.pathname === '/activity'}
                >
                    <ListItemIcon>
                        <ActivityIcon />
                    </ListItemIcon>
                    <ListItemText primary="Activity" />
                </ListItemButton>

                {currentUser?.role === 'admin' && (
                    <>
                        <ListItemButton
                            onClick={() => handleNavigation('/admin/integrations/global')}
                            selected={location.pathname === '/admin/integrations/global'}
                        >
                            <ListItemIcon>
                                <AdminIcon />
                            </ListItemIcon>
                            <ListItemText primary="Global Integrations" />
                        </ListItemButton>
                    </>
                )}

                <Divider sx={{ my: 2 }} />

                <ListItemButton
                    onClick={() => {
                        localStorage.removeItem('token');
                        window.location.href = '/';
                    }}
                >
                    <ListItemIcon>
                        <LogoutIcon />
                    </ListItemIcon>
                    <ListItemText primary="Logout" />
                </ListItemButton>
            </List>
        </div>
    );
};

export default Dashboard;
