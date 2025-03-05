import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { 
    Card, 
    CardContent, 
    Typography, 
    Avatar, 
    Box, 
    Paper, 
    Grid, 
    Divider, 
    Button, 
    Dialog, 
    DialogTitle, 
    DialogContent, 
    DialogActions,
    IconButton
} from '@mui/material';
import { formatDistanceToNow } from 'date-fns';
import EditIcon from '@mui/icons-material/Edit';
import { avatarOptions, getAvatarColor } from '../utils/avatarUtils';
import { useAppContext } from '../context/AppContext';
import { blurActiveElement } from '../utils/focusUtils';
import { refreshPage } from '../utils/refreshUtils';

const UserProfile = () => {
    const { currentUser, refreshData, refreshAvatars } = useAppContext();
    const [user, setUser] = useState(null);
    const [userStats, setUserStats] = useState({ postCount: 0, commentCount: 0 });
    const [error, setError] = useState('');
    const [openAvatarDialog, setOpenAvatarDialog] = useState(false);
    const [selectedAvatar, setSelectedAvatar] = useState('default');
    const [isUpdating, setIsUpdating] = useState(false);

    useEffect(() => {
        const fetchUserData = async () => {
            try {
                const [userRes, postsRes] = await Promise.all([
                    axios.get('/api/auth/profile', {
                        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
                    }),
                    axios.get('/api/posts')
                ]);

                setUser(userRes.data);
                setSelectedAvatar(userRes.data.profilePicture || 'default');

                // Calculate post count and comment count
                const userPosts = postsRes.data.filter(post => post.userId._id === userRes.data._id);
                const userComments = postsRes.data.reduce((count, post) => {
                    return count + (post.comments || []).filter(comment => 
                        comment.userId && 
                        comment.userId._id && 
                        comment.userId._id === userRes.data._id
                    ).length;
                }, 0);

                setUserStats({
                    postCount: userPosts.length,
                    commentCount: userComments
                });
            } catch (err) {
                setError('Failed to fetch user data. Please try again later.');
            }
        };
        fetchUserData();
    }, []);

    const handleOpenAvatarDialog = () => {
        setOpenAvatarDialog(true);
    };

    const handleCloseAvatarDialog = () => {
        setOpenAvatarDialog(false);
        blurActiveElement();
    };

    const handleAvatarSelect = (avatarId) => {
        setSelectedAvatar(avatarId);
    };

    const handleSaveAvatar = async () => {
        setIsUpdating(true);
        try {
            const response = await axios.put(
                '/api/auth/profile',
                { profilePicture: selectedAvatar },
                { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } }
            );
            setUser(response.data);
            handleCloseAvatarDialog();
            
            // Trigger a refresh of the app context data
            refreshData();
            
            // Trigger a page refresh after a short delay
            refreshPage(500);
        } catch (err) {
            setError('Failed to update profile. Please try again.');
        } finally {
            setIsUpdating(false);
        }
    };

    if (error) return (
        <Typography color="error" sx={{ p: 2 }}>{error}</Typography>
    );
    if (!user) return (
        <Typography sx={{ p: 2 }}>Loading...</Typography>
    );

    return (
        <Box sx={{ maxWidth: 800, mx: 'auto', p: 3, mt: 8 }}>
            <Card sx={{ mb: 4 }}>
                <CardContent>
                    <Box sx={{ display: 'flex', alignItems: 'center', mb: 3 }}>
                        <Box sx={{ position: 'relative' }}>
                            <Avatar 
                                sx={{ 
                                    width: 100, 
                                    height: 100, 
                                    mr: 3,
                                    bgcolor: getAvatarColor(user.profilePicture),
                                    fontSize: '2.5rem'
                                }}
                            >
                                {user.username.charAt(0).toUpperCase()}
                            </Avatar>
                            <IconButton 
                                sx={{ 
                                    position: 'absolute', 
                                    bottom: 0, 
                                    right: 12,
                                    bgcolor: 'background.paper',
                                    '&:hover': { bgcolor: 'background.default' }
                                }}
                                onClick={handleOpenAvatarDialog}
                                size="small"
                            >
                                <EditIcon fontSize="small" />
                            </IconButton>
                        </Box>
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
                                <Typography variant="h4" sx={{ fontSize: '1.8rem' }}>
                                    {userStats.postCount}
                                </Typography>
                            </Paper>
                        </Grid>
                        <Grid item xs={12} sm={4}>
                            <Paper sx={{ p: 2, textAlign: 'center' }}>
                                <Typography variant="h6" color="primary">
                                    Comments
                                </Typography>
                                <Typography variant="h4" sx={{ fontSize: '1.8rem' }}>
                                    {userStats.commentCount}
                                </Typography>
                            </Paper>
                        </Grid>
                        <Grid item xs={12} sm={4}>
                            <Paper sx={{ p: 2, textAlign: 'center' }}>
                                <Typography variant="h6" color="primary">
                                    Joined
                                </Typography>
                                <Typography variant="h4" sx={{ fontSize: '1.5rem' }}>
                                    {new Date(user.createdAt).toLocaleDateString()}
                                </Typography>
                            </Paper>
                        </Grid>
                    </Grid>
                </CardContent>
            </Card>

            {/* Avatar Selection Dialog */}
            <Dialog 
                open={openAvatarDialog} 
                onClose={handleCloseAvatarDialog}
                disableRestoreFocus={true}
            >
                <DialogTitle>Choose Your Avatar Color</DialogTitle>
                <DialogContent>
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, justifyContent: 'center', my: 2 }}>
                        {avatarOptions.map((avatar) => (
                            <Avatar
                                key={avatar.id}
                                sx={{
                                    width: 60,
                                    height: 60,
                                    bgcolor: avatar.color,
                                    fontSize: '1.5rem',
                                    cursor: 'pointer',
                                    border: selectedAvatar === avatar.id ? '3px solid #1976d2' : 'none',
                                }}
                                onClick={() => handleAvatarSelect(avatar.id)}
                            >
                                {user.username.charAt(0).toUpperCase()}
                            </Avatar>
                        ))}
                    </Box>
                </DialogContent>
                <DialogActions>
                    <Button onClick={handleCloseAvatarDialog}>Cancel</Button>
                    <Button 
                        onClick={handleSaveAvatar} 
                        variant="contained" 
                        disabled={isUpdating}
                    >
                        {isUpdating ? 'Saving...' : 'Save'}
                    </Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
};

export default UserProfile;
