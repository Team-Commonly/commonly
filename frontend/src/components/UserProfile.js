import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Card, CardContent, Typography, Avatar, Box, Paper, Grid, Divider } from '@mui/material';
import { formatDistanceToNow } from 'date-fns';

const UserProfile = () => {
    const [user, setUser] = useState(null);
    const [error, setError] = useState('');

    useEffect(() => {
        const fetchUser = async () => {
            try {
                const res = await axios.get(`/api/auth/profile`, {
                    headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
                });
                setUser(res.data);
            } catch (err) {
                setError('Failed to fetch user profile. Please try again later.');
            }
        };
        fetchUser();
    }, []);

    if (error) return (
        <Typography color="error" sx={{ p: 2 }}>{error}</Typography>
    );
    if (!user) return (
        <Typography sx={{ p: 2 }}>Loading...</Typography>
    );

    return (
        <Box sx={{ maxWidth: 800, mx: 'auto', p: 3 }}>
            <Card sx={{ mb: 4 }}>
                <CardContent>
                    <Box sx={{ display: 'flex', alignItems: 'center', mb: 3 }}>
                        <Avatar 
                            sx={{ 
                                width: 100, 
                                height: 100, 
                                mr: 3,
                                bgcolor: 'primary.main',
                                fontSize: '2.5rem'
                            }}
                        >
                            {user.username.charAt(0).toUpperCase()}
                        </Avatar>
                        <Box>
                            <Typography variant="h4" gutterBottom>
                                {user.username}
                            </Typography>
                            <Typography variant="body1" color="text.secondary">
                                {user.email}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                                Member since {formatDistanceToNow(new Date(user.createdAt))} ago
                            </Typography>
                        </Box>
                    </Box>
                    
                    <Divider sx={{ my: 3 }} />
                    
                    <Grid container spacing={3}>
                        <Grid item xs={12} sm={4}>
                            <Paper sx={{ p: 2, textAlign: 'center' }}>
                                <Typography variant="h6" color="primary">
                                    Posts
                                </Typography>
                                <Typography variant="h4">
                                    {user.posts?.length || 0}
                                </Typography>
                            </Paper>
                        </Grid>
                        <Grid item xs={12} sm={4}>
                            <Paper sx={{ p: 2, textAlign: 'center' }}>
                                <Typography variant="h6" color="primary">
                                    Comments
                                </Typography>
                                <Typography variant="h4">
                                    {user.comments?.length || 0}
                                </Typography>
                            </Paper>
                        </Grid>
                        <Grid item xs={12} sm={4}>
                            <Paper sx={{ p: 2, textAlign: 'center' }}>
                                <Typography variant="h6" color="primary">
                                    Joined
                                </Typography>
                                <Typography variant="h4">
                                    {new Date(user.createdAt).toLocaleDateString()}
                                </Typography>
                            </Paper>
                        </Grid>
                    </Grid>
                </CardContent>
            </Card>
        </Box>
    );
};

export default UserProfile;
