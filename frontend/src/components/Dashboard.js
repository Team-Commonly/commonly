import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Link, useLocation } from 'react-router-dom';
import { List, ListItem, ListItemIcon, ListItemText, Typography, Avatar, Divider, Box } from '@mui/material';
import { Home as HomeIcon, Person as PersonIcon, Add as AddIcon, ExitToApp as LogoutIcon } from '@mui/icons-material';
import { getAvatarColor } from '../utils/avatarUtils';
import { useAppContext } from '../context/AppContext';

const Dashboard = () => {
    const { currentUser, loading } = useAppContext();
    const [error, setError] = useState('');
    const location = useLocation();

    const sidebarStyles = {
        width: 280,
        height: '100vh',
        position: 'fixed',
        left: 0,
        top: 0,
        backgroundColor: '#ffffff',
        boxShadow: '2px 0 5px rgba(0,0,0,0.1)',
        padding: '20px 0',
        overflowY: 'auto'
    };

    if (error) return <Typography color="error" sx={{ p: 2 }}>{error}</Typography>;
    if (loading || !currentUser) return <Typography sx={{ p: 2 }}>Loading...</Typography>;

    return (
        <div style={sidebarStyles}>
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', mb: 3, mt: 2, px: 2 }}>
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
            </Box>
            
            <Divider sx={{ mb: 2 }} />
            
            <List component="nav">
                <ListItem 
                    button 
                    component={Link} 
                    to="/feed"
                    selected={location.pathname === '/feed'}
                >
                    <ListItemIcon>
                        <HomeIcon />
                    </ListItemIcon>
                    <ListItemText primary="Feed" />
                </ListItem>
                
                <ListItem 
                    button 
                    component={Link} 
                    to="/profile"
                    selected={location.pathname === '/profile'}
                >
                    <ListItemIcon>
                        <PersonIcon />
                    </ListItemIcon>
                    <ListItemText primary="Profile" />
                </ListItem>
                
                <ListItem 
                    button 
                    component={Link} 
                    to="/create-post"
                    selected={location.pathname === '/create-post'}
                >
                    <ListItemIcon>
                        <AddIcon />
                    </ListItemIcon>
                    <ListItemText primary="Create Post" />
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