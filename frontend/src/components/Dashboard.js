import React, { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { List, ListItem, ListItemIcon, ListItemText, Typography, Avatar, Divider, Box, Skeleton } from '@mui/material';
import { 
    Home as HomeIcon, 
    Person as PersonIcon, 
    ExitToApp as LogoutIcon,
    Chat as ChatIcon
} from '@mui/icons-material';
import { getAvatarColor } from '../utils/avatarUtils';
import { useAppContext } from '../context/AppContext';

const Dashboard = () => {
    const { currentUser, userLoading, refreshData } = useAppContext();
    const [error, setError] = useState('');
    const location = useLocation();

    const sidebarStyles = {
        width: 280,
        height: '100vh',
        position: 'fixed',
        left: 0,
        top: 0,
        backgroundColor: '#ffffff',
        boxShadow: '3px 0 10px rgba(0,0,0,0.15)',
        padding: '20px 0',
        overflowY: 'auto',
        zIndex: 1100
    };

    // Function to handle navigation with refresh
    const handleNavigation = (path) => {
        // Refresh data to ensure we have the latest state
        refreshData();
        
        // Use window.location for a full page refresh
        window.location.href = path;
    };

    if (error) return <Typography color="error" sx={{ p: 2 }}>{error}</Typography>;

    return (
        <div style={sidebarStyles}>
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', mb: 3, mt: 2, px: 2 }}>
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
                                bgcolor: getAvatarColor(currentUser.profilePicture) 
                            }}
                        >
                            {currentUser.username.charAt(0).toUpperCase()}
                        </Avatar>
                        <Typography variant="h6" sx={{ fontWeight: 'bold' }}>
                            {currentUser.username}
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                            {currentUser.email}
                        </Typography>
                    </>
                ) : (
                    <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
                        <Typography>Please log in</Typography>
                    </Box>
                )}
            </Box>
            
            <Divider sx={{ mb: 2 }} />
            
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