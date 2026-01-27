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
    IconButton,
    Tabs,
    Tab,
    Chip,
    TextField,
    Alert,
    Tooltip,
    Snackbar
} from '@mui/material';
import { formatDistanceToNow } from 'date-fns';
import EditIcon from '@mui/icons-material/Edit';
import DeveloperModeIcon from '@mui/icons-material/DeveloperMode';
import AppsIcon from '@mui/icons-material/Apps';
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings';
import PsychologyIcon from '@mui/icons-material/Psychology';
import KeyIcon from '@mui/icons-material/Key';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import RefreshIcon from '@mui/icons-material/Refresh';
import DeleteIcon from '@mui/icons-material/Delete';
import { avatarOptions, getAvatarColor } from '../utils/avatarUtils';
import { useAppContext } from '../context/AppContext';
import { useLayout } from '../context/LayoutContext';
import { blurActiveElement } from '../utils/focusUtils';
import { useNavigate } from 'react-router-dom';
import AppsManagement from './AppsManagement';

const UserProfile = () => {
    const { refreshAvatars } = useAppContext();
    const navigate = useNavigate();
    const [user, setUser] = useState(null);
    const [userStats, setUserStats] = useState({ postCount: 0, commentCount: 0 });
    const [error, setError] = useState('');
    const [openAvatarDialog, setOpenAvatarDialog] = useState(false);
    const [selectedAvatar, setSelectedAvatar] = useState('default');
    const [isUpdating, setIsUpdating] = useState(false);
    const [currentTab, setCurrentTab] = useState(0);
    const [apiToken, setApiToken] = useState(null);
    const [apiTokenCreatedAt, setApiTokenCreatedAt] = useState(null);
    const [isGeneratingToken, setIsGeneratingToken] = useState(false);
    const [isRevokingToken, setIsRevokingToken] = useState(false);
    const [showToken, setShowToken] = useState(false);
    const [snackbar, setSnackbar] = useState({ open: false, message: '', severity: 'info' });

    useEffect(() => {
        const fetchUserData = async () => {
            try {
                const [userRes, postsRes, tokenRes] = await Promise.all([
                    axios.get('/api/auth/profile', {
                        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
                    }),
                    axios.get('/api/posts'),
                    axios.get('/api/auth/api-token', {
                        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
                    }).catch(() => ({ data: { hasToken: false } }))
                ]);

                setUser(userRes.data);
                setSelectedAvatar(userRes.data.profilePicture || 'default');

                // Set API token info
                if (tokenRes.data.hasToken) {
                    setApiToken(tokenRes.data.token);
                    setApiTokenCreatedAt(tokenRes.data.createdAt);
                }

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
            
            // Use the refreshAvatars function instead to ensure consistent avatar display
            refreshAvatars();
        } catch (err) {
            setError('Failed to update profile. Please try again.');
        } finally {
            setIsUpdating(false);
        }
    };

    const handleGenerateApiToken = async () => {
        setIsGeneratingToken(true);
        try {
            const response = await axios.post('/api/auth/api-token/generate', {}, {
                headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
            });
            
            setApiToken(response.data.apiToken);
            setApiTokenCreatedAt(response.data.createdAt);
            setShowToken(true);
            setSnackbar({
                open: true,
                message: 'API token generated successfully',
                severity: 'success'
            });
        } catch (err) {
            setSnackbar({
                open: true,
                message: 'Failed to generate API token',
                severity: 'error'
            });
        } finally {
            setIsGeneratingToken(false);
        }
    };

    const handleRevokeApiToken = async () => {
        setIsRevokingToken(true);
        try {
            await axios.delete('/api/auth/api-token', {
                headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
            });
            
            setApiToken(null);
            setApiTokenCreatedAt(null);
            setShowToken(false);
            setSnackbar({
                open: true,
                message: 'API token revoked successfully',
                severity: 'success'
            });
        } catch (err) {
            setSnackbar({
                open: true,
                message: 'Failed to revoke API token',
                severity: 'error'
            });
        } finally {
            setIsRevokingToken(false);
        }
    };

    const handleCopyToken = () => {
        if (apiToken) {
            navigator.clipboard.writeText(apiToken);
            setSnackbar({
                open: true,
                message: 'API token copied to clipboard',
                severity: 'success'
            });
        }
    };

    const handleCloseSnackbar = () => {
        setSnackbar({ ...snackbar, open: false });
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
                    
                    <Divider sx={{ my: 3 }} />
                    
                    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <Typography variant="h6" color="primary">
                            Account Type
                        </Typography>
                        <Chip 
                            icon={user.role === 'admin' ? <AdminPanelSettingsIcon /> : undefined}
                            label={user.role === 'admin' ? 'Administrator' : 'User'}
                            color={user.role === 'admin' ? 'primary' : 'default'}
                            variant={user.role === 'admin' ? 'filled' : 'outlined'}
                        />
                    </Box>
                    
                    {user.role === 'admin' && (
                        <Box sx={{ display: 'flex', justifyContent: 'center', gap: 1, mt: 2 }}>
                            <Button
                                variant="outlined"
                                startIcon={<DeveloperModeIcon />}
                                onClick={() => navigate('/dev/api')}
                            >
                                API Development Tools
                            </Button>
                            <Button
                                variant="outlined"
                                startIcon={<PsychologyIcon />}
                                onClick={() => navigate('/dev/pod-context')}
                            >
                                Pod Context Inspector
                            </Button>
                        </Box>
                    )}
                </CardContent>
            </Card>

            {/* Profile Tabs */}
            <Card>
                <Tabs 
                    value={currentTab} 
                    onChange={(e, newValue) => setCurrentTab(newValue)}
                    sx={{ borderBottom: 1, borderColor: 'divider' }}
                >
                    <Tab label="Overview" />
                    <Tab 
                        label="Apps" 
                        icon={<AppsIcon />} 
                        iconPosition="start"
                    />
                    <Tab
                        label="API Token"
                        icon={<KeyIcon />}
                        iconPosition="start"
                    />
                </Tabs>
                
                <CardContent>
                    {currentTab === 0 && (
                        <Box>
                            <Typography variant="h6" gutterBottom>
                                Account Overview
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                                View your account statistics and recent activity here.
                            </Typography>
                        </Box>
                    )}
                    
                    {currentTab === 1 && <AppsManagement />}
                    
                    {currentTab === 2 && (
                        <Box>
                            <Typography variant="h6" gutterBottom>
                                API Token Management
                            </Typography>
                            <Typography variant="body2" color="text.secondary" gutterBottom>
                                Generate an API token to access the Commonly API programmatically. 
                                Keep your token secure and don&apos;t share it publicly.
                            </Typography>
                            
                            {apiToken ? (
                                <Box sx={{ mt: 3 }}>
                                    <Alert severity="info" sx={{ mb: 3 }}>
                                        Your API token was created on {' '}
                                        {new Date(apiTokenCreatedAt).toLocaleDateString()} at {' '}
                                        {new Date(apiTokenCreatedAt).toLocaleTimeString()}
                                    </Alert>
                                    
                                    <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', mb: 2 }}>
                                        <TextField
                                            label="API Token"
                                            value={showToken ? apiToken : '••••••••••••••••••••••••••••••••'}
                                            fullWidth
                                            variant="outlined"
                                            InputProps={{
                                                readOnly: true,
                                                sx: { fontFamily: 'monospace' }
                                            }}
                                        />
                                        <Tooltip title="Copy to clipboard">
                                            <IconButton onClick={handleCopyToken} color="primary">
                                                <ContentCopyIcon />
                                            </IconButton>
                                        </Tooltip>
                                        <Tooltip title={showToken ? "Hide token" : "Show token"}>
                                            <IconButton 
                                                onClick={() => setShowToken(!showToken)}
                                                color="primary"
                                            >
                                                {showToken ? <EditIcon /> : <KeyIcon />}
                                            </IconButton>
                                        </Tooltip>
                                    </Box>
                                    
                                    <Box sx={{ display: 'flex', gap: 2 }}>
                                        <Button
                                            variant="outlined"
                                            startIcon={<RefreshIcon />}
                                            onClick={handleGenerateApiToken}
                                            disabled={isGeneratingToken}
                                        >
                                            {isGeneratingToken ? 'Regenerating...' : 'Regenerate'}
                                        </Button>
                                        <Button
                                            variant="outlined"
                                            color="error"
                                            startIcon={<DeleteIcon />}
                                            onClick={handleRevokeApiToken}
                                            disabled={isRevokingToken}
                                        >
                                            {isRevokingToken ? 'Revoking...' : 'Revoke'}
                                        </Button>
                                    </Box>
                                </Box>
                            ) : (
                                <Box sx={{ mt: 3, textAlign: 'center' }}>
                                    <Typography variant="body1" gutterBottom>
                                        No API token has been generated yet.
                                    </Typography>
                                    <Button
                                        variant="contained"
                                        startIcon={<KeyIcon />}
                                        onClick={handleGenerateApiToken}
                                        disabled={isGeneratingToken}
                                        sx={{ mt: 2 }}
                                    >
                                        {isGeneratingToken ? 'Generating...' : 'Generate API Token'}
                                    </Button>
                                </Box>
                            )}
                            
                            <Divider sx={{ my: 3 }} />
                            
                            <Typography variant="h6" gutterBottom>
                                Usage Example
                            </Typography>
                            <Paper sx={{ p: 2, bgcolor: 'grey.100', mt: 2 }}>
                                <Typography 
                                    variant="body2" 
                                    component="pre" 
                                    sx={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}
                                >
{`curl -H "Authorization: Bearer YOUR_API_TOKEN" \\
     -H "Content-Type: application/json" \\
     ${window.location.origin}/api/auth/profile`}
                                </Typography>
                            </Paper>
                        </Box>
                    )}

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

            {/* Snackbar for notifications */}
            <Snackbar
                open={snackbar.open}
                autoHideDuration={4000}
                onClose={handleCloseSnackbar}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
            >
                <Alert 
                    onClose={handleCloseSnackbar} 
                    severity={snackbar.severity}
                    variant="filled"
                >
                    {snackbar.message}
                </Alert>
            </Snackbar>
        </Box>
    );
};

export default UserProfile;
