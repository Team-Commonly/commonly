import React from 'react';
import { useLocation } from 'react-router-dom';
import { 
    List, ListItem, ListItemIcon, ListItemText, Typography, 
    Avatar, Divider, Box, Skeleton, IconButton
} from '@mui/material';
import { 
    Home as HomeIcon, 
    Person as PersonIcon, 
    ExitToApp as LogoutIcon,
    Chat as ChatIcon,
    ChevronLeft as ChevronLeftIcon
} from '@mui/icons-material';
import { getAvatarColor } from '../utils/avatarUtils';
import { useAppContext } from '../context/AppContext';
import { useLayout } from '../context/LayoutContext';
import './Dashboard.css';

const Dashboard = () => {
    const { currentUser, userLoading, refreshData } = useAppContext();
    const { isDashboardCollapsed, toggleDashboard } = useLayout();
    const location = useLocation();

    // Function to handle navigation with refresh
    const handleNavigation = (path) => {
        // Refresh data to ensure we have the latest state
        refreshData();
        
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
                                    src={currentUser.profilePicture}
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
                    onClick={() => handleNavigation('/pods')}
                    selected={location.pathname.startsWith('/pods')}
                >
                    <ListItemIcon>
                        <ChatIcon />
                    </ListItemIcon>
                    <ListItemText primary="Pods" />
                </ListItem>
                
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