import React from 'react';
import { useLocation } from 'react-router-dom';
import { 
    List, ListItem, ListItemIcon, ListItemText, Typography, 
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
import './Dashboard.css';

const Dashboard = () => {
    const { currentUser, userLoading, refreshData } = useAppContext();
    const { isDashboardCollapsed, toggleDashboard } = useLayout();
    const location = useLocation();
    const theme = useTheme();
    const isMobile = useMediaQuery(theme.breakpoints.down('md'));

    // Function to handle navigation with refresh
    const handleNavigation = (path) => {
        // Refresh data to ensure we have the latest state
        refreshData();

        if (isMobile && !isDashboardCollapsed) {
            toggleDashboard();
        }
        
        // Use window.location for a full page refresh
        window.location.href = path;
    };

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
                <ListItem 
                    button 
                    onClick={() => handleNavigation('/feed')}
                    selected={location.pathname === '/feed'}
                >
                    <ListItemIcon>
                        <HomeIcon />
                    </ListItemIcon>
                    <ListItemText primary="Feed" />
                </ListItem>
                
                <ListItem 
                    button 
                    onClick={() => handleNavigation('/profile')}
                    selected={location.pathname === '/profile'}
                >
                    <ListItemIcon>
                        <PersonIcon />
                    </ListItemIcon>
                    <ListItemText primary="Profile" />
                </ListItem>
                
                <ListItem 
                    button 
                    onClick={() => handleNavigation('/digest')}
                    selected={location.pathname === '/digest'}
                >
                    <ListItemIcon>
                        <EmailIcon />
                    </ListItemIcon>
                    <ListItemText primary="Daily Digest" />
                </ListItem>
                
                <ListItem
                    button
                    onClick={() => handleNavigation('/pods')}
                    selected={location.pathname.startsWith('/pods') && !location.pathname.includes('agent-admin')}
                >
                    <ListItemIcon>
                        <ChatIcon />
                    </ListItemIcon>
                    <ListItemText primary="Pods" />
                </ListItem>
                <ListItem
                    button
                    onClick={() => handleNavigation('/pods/agent-admin')}
                    selected={location.pathname === '/pods/agent-admin'}
                >
                    <ListItemIcon>
                        <ForumIcon />
                    </ListItemIcon>
                    <ListItemText primary="Agent Admin" />
                </ListItem>

                <ListItem
                    button
                    onClick={() => handleNavigation('/agents')}
                    selected={location.pathname === '/agents'}
                >
                    <ListItemIcon>
                        <AgentsIcon />
                    </ListItemIcon>
                    <ListItemText primary="Agents" />
                </ListItem>

                <ListItem
                    button
                    onClick={() => handleNavigation('/skills')}
                    selected={location.pathname === '/skills'}
                >
                    <ListItemIcon>
                        <SkillsIcon />
                    </ListItemIcon>
                    <ListItemText primary="Skills" />
                </ListItem>

                <ListItem
                    button
                    onClick={() => handleNavigation('/apps')}
                    selected={location.pathname === '/apps'}
                >
                    <ListItemIcon>
                        <AppsIcon />
                    </ListItemIcon>
                    <ListItemText primary="Apps" />
                </ListItem>

                <ListItem
                    button
                    onClick={() => handleNavigation('/activity')}
                    selected={location.pathname === '/activity'}
                >
                    <ListItemIcon>
                        <ActivityIcon />
                    </ListItemIcon>
                    <ListItemText primary="Activity" />
                </ListItem>

                {currentUser?.role === 'admin' && (
                    <>
                        <ListItem
                            button
                            onClick={() => handleNavigation('/admin/integrations/global')}
                            selected={location.pathname === '/admin/integrations/global'}
                        >
                            <ListItemIcon>
                                <AdminIcon />
                            </ListItemIcon>
                            <ListItemText primary="Global Integrations" />
                        </ListItem>

                    </>
                )}

                <Divider sx={{ my: 2 }} />
                
                <ListItem 
                    button 
                    onClick={() => {
                        localStorage.removeItem('token');
                        window.location.href = '/';
                    }}
                >
                    <ListItemIcon>
                        <LogoutIcon />
                    </ListItemIcon>
                    <ListItemText primary="Logout" />
                </ListItem>
            </List>
        </div>
    );
};

export default Dashboard;
