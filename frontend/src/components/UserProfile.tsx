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
import { avatarOptions, getAvatarColor, getAvatarSrc } from '../utils/avatarUtils';
import { useAppContext } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { blurActiveElement } from '../utils/focusUtils';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import AppsManagement from './AppsManagement';
import AvatarGenerator from './agents/AvatarGenerator';
import AdminUsers from './admin/AdminUsers';
import { useV2Embedded } from '../v2/hooks/useV2Embedded';

interface ProfileUser {
    _id: string;
    username: string;
    email: string;
    role?: string;
    profilePicture?: string;
    createdAt: string;
    isFollowing?: boolean;
    followersCount?: number;
    followingCount?: number;
}

interface UserStats {
    postCount: number;
    commentCount: number;
}

interface PublicPost {
    id: string;
    content?: string;
    category?: string;
    createdAt: string;
}

interface JoinedPod {
    id: string;
    name: string;
    type?: string;
    membersCount?: number;
}

interface PublicActivity {
    recentPublicPosts: PublicPost[];
    joinedPods: JoinedPod[];
}

interface SnackbarState {
    open: boolean;
    message: string;
    severity: 'info' | 'error' | 'success' | 'warning';
}

const UserProfile = () => {
    const v2Embedded = useV2Embedded();
    const { refreshAvatars } = useAppContext();
    const { currentUser } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();
    const { id: profileId } = useParams<{ id?: string }>();
    const [user, setUser] = useState<ProfileUser | null>(null);
    const [userStats, setUserStats] = useState<UserStats>({ postCount: 0, commentCount: 0 });
    const [error, setError] = useState('');
    const [openAvatarDialog, setOpenAvatarDialog] = useState(false);
    const [selectedAvatar, setSelectedAvatar] = useState('default');
    const [avatarFile, setAvatarFile] = useState<File | null>(null);
    const [avatarPreview, setAvatarPreview] = useState('');
    const [isUpdating, setIsUpdating] = useState(false);
    const [avatarGeneratorOpen, setAvatarGeneratorOpen] = useState(false);
    const [currentTab, setCurrentTab] = useState('overview');
    const [apiToken, setApiToken] = useState<string | null>(null);
    const [apiTokenCreatedAt, setApiTokenCreatedAt] = useState<string | null>(null);
    const [isGeneratingToken, setIsGeneratingToken] = useState(false);
    const [isRevokingToken, setIsRevokingToken] = useState(false);
    const [isFollowLoading, setIsFollowLoading] = useState(false);
    const [showToken, setShowToken] = useState(false);
    const [snackbar, setSnackbar] = useState<SnackbarState>({ open: false, message: '', severity: 'info' });
    const [publicActivity, setPublicActivity] = useState<PublicActivity>({ recentPublicPosts: [], joinedPods: [] });
    const [publicActivityLoading, setPublicActivityLoading] = useState(false);

    useEffect(() => {
        const fetchUserData = async () => {
            try {
                const profilePath = profileId ? `/api/users/${profileId}` : '/api/users/profile';
                const [userRes, postsRes, tokenRes] = await Promise.all([
                    axios.get(profilePath, {
                        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
                    }),
                    axios.get('/api/posts', { params: { limit: 50 } }),
                    !profileId ? axios.get('/api/auth/api-token', {
                        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
                    }).catch(() => ({ data: { hasToken: false } })) : Promise.resolve({ data: { hasToken: false } })
                ]);

                setUser(userRes.data);
                setSelectedAvatar(userRes.data.profilePicture || 'default');

                const resolvedUserId = userRes.data?._id;
                if (resolvedUserId) {
                    setPublicActivityLoading(true);
                    try {
                        const activityRes = await axios.get(`/api/users/${resolvedUserId}/public-activity`, {
                            headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
                        });
                        setPublicActivity({
                            recentPublicPosts: activityRes.data?.recentPublicPosts || [],
                            joinedPods: activityRes.data?.joinedPods || [],
                        });
                    } catch (activityError) {
                        setPublicActivity({ recentPublicPosts: [], joinedPods: [] });
                    } finally {
                        setPublicActivityLoading(false);
                    }
                } else {
                    setPublicActivity({ recentPublicPosts: [], joinedPods: [] });
                    setPublicActivityLoading(false);
                }

                // Set API token info
                if (tokenRes.data.hasToken) {
                    setApiToken(tokenRes.data.token);
                    setApiTokenCreatedAt(tokenRes.data.createdAt);
                }

                // Calculate post count and comment count
                const allPosts = postsRes.data.posts || postsRes.data;
                const userPosts = allPosts.filter((post: { userId?: { _id?: string } }) => post.userId && post.userId._id === userRes.data._id);
                const userComments = allPosts.reduce((count: number, post: { comments?: Array<{ userId?: { _id?: string } }> }) => {
                    return count + (post.comments || []).filter((comment) =>
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
    }, [profileId]);

    useEffect(() => {
        const queryTab = new URLSearchParams(location.search).get('tab');
        if (!queryTab) return;
        if (['overview', 'apps', 'api-token', 'user-admin'].includes(queryTab)) {
            setCurrentTab(queryTab);
        }
    }, [location.search]);

    const handleOpenAvatarDialog = () => {
        setOpenAvatarDialog(true);
    };

    const handleCloseAvatarDialog = () => {
        setOpenAvatarDialog(false);
        setAvatarFile(null);
        setAvatarPreview('');
        blurActiveElement();
    };

    const handleAvatarSelect = (avatarId: string) => {
        setSelectedAvatar(avatarId);
        setAvatarFile(null);
        setAvatarPreview('');
    };

    const handleGeneratedAvatarSelect = (avatarDataUri: string) => {
        if (!avatarDataUri) return;
        setSelectedAvatar(avatarDataUri);
        setAvatarFile(null);
        setAvatarPreview('');
        setAvatarGeneratorOpen(false);
    };

    const handleAvatarFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        setAvatarFile(file);
        setAvatarPreview(URL.createObjectURL(file));
        setSelectedAvatar('default');
    };

    const handleSaveAvatar = async () => {
        setIsUpdating(true);
        try {
            let nextProfilePicture = selectedAvatar;
            if (avatarFile) {
                const formData = new FormData();
                formData.append('image', avatarFile);
                const uploadRes = await axios.post('/api/uploads', formData, {
                    headers: {
                        Authorization: `Bearer ${localStorage.getItem('token')}`,
                        'Content-Type': 'multipart/form-data'
                    }
                });
                nextProfilePicture = uploadRes.data?.url || selectedAvatar;
            }
            const response = await axios.put(
                '/api/users/profile',
                { profilePicture: nextProfilePicture },
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

    const handleToggleFollow = async () => {
        if (!user?._id || isFollowLoading) return;
        setIsFollowLoading(true);
        try {
            if (user.isFollowing) {
                const response = await axios.delete(`/api/users/${user._id}/follow`, {
                    headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
                });
                setUser((prev) => prev ? ({
                    ...prev,
                    isFollowing: false,
                    followersCount: response.data?.target?.followersCount ?? Math.max((prev.followersCount || 1) - 1, 0),
                }) : prev);
            } else {
                const response = await axios.post(`/api/users/${user._id}/follow`, {}, {
                    headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
                });
                setUser((prev) => prev ? ({
                    ...prev,
                    isFollowing: true,
                    followersCount: response.data?.target?.followersCount ?? ((prev.followersCount || 0) + 1),
                }) : prev);
            }
        } catch (err) {
            setSnackbar({
                open: true,
                message: 'Failed to update follow status',
                severity: 'error'
            });
        } finally {
            setIsFollowLoading(false);
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

    const canManageUsers = Boolean((!profileId || (currentUser && currentUser._id === user?._id)) && user?.role === 'admin');

    useEffect(() => {
        if (user && !canManageUsers && currentTab === 'user-admin') {
            setCurrentTab('overview');
        }
    }, [user, canManageUsers, currentTab]);

    if (error) return (
        <Typography color="error" sx={{ p: 2 }}>{error}</Typography>
    );
    if (!user) return (
        <Typography sx={{ p: 2 }}>Loading...</Typography>
    );
    const isOwnProfile = !profileId || (currentUser && currentUser._id === user._id);
    const isSelectedAvatarColor = avatarOptions.some((avatar) => avatar.id === selectedAvatar);

    return (
        <Box sx={{ maxWidth: 1000, mx: 'auto', p: { xs: 2, md: 4 }, mt: { xs: 2, md: 6 } }}>
            <Card sx={{ mb: 4, borderRadius: 3 }}>
                <CardContent sx={{ p: { xs: 2, md: 3 } }}>
                    <Grid container spacing={3} alignItems="center">
                        <Grid item xs={12} md={4}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                                <Box sx={{ position: 'relative' }}>
                                    <Avatar
                                        sx={{
                                            width: v2Embedded ? 72 : 96,
                                            height: v2Embedded ? 72 : 96,
                                            bgcolor: getAvatarColor(user.profilePicture),
                                            fontSize: v2Embedded ? '1.6rem' : '2.2rem',
                                        }}
                                        src={getAvatarSrc(user.profilePicture)}
                                    >
                                        {user.username.charAt(0).toUpperCase()}
                                    </Avatar>
                                    {isOwnProfile && (
                                        <IconButton
                                            sx={{
                                                position: 'absolute',
                                                bottom: 0,
                                                right: -4,
                                                bgcolor: 'background.paper',
                                                border: '1px solid',
                                                borderColor: 'divider',
                                                '&:hover': { bgcolor: 'background.default' }
                                            }}
                                            onClick={handleOpenAvatarDialog}
                                            size="small"
                                        >
                                            <EditIcon fontSize="small" />
                                        </IconButton>
                                    )}
                                </Box>
                                <Box>
                                    {/* The v2 shell already names the page (Profile),
                                        so under v2 we drop the in-card h4 username
                                        and keep the secondary metadata only. */}
                                    {!v2Embedded && (
                                        <Typography variant="h4" gutterBottom>
                                            {user.username}
                                        </Typography>
                                    )}
                                    {v2Embedded && (
                                        <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                                            {user.username}
                                        </Typography>
                                    )}
                                    <Typography variant="body2" color="text.secondary">
                                        {user.email}
                                    </Typography>
                                    <Typography variant="caption" color="text.secondary">
                                        Member since {formatDistanceToNow(new Date(user.createdAt))} ago
                                    </Typography>
                                    {!isOwnProfile && (
                                        <Box sx={{ mt: 1 }}>
                                            <Button
                                                size="small"
                                                variant={user.isFollowing ? 'outlined' : 'contained'}
                                                onClick={handleToggleFollow}
                                                disabled={isFollowLoading}
                                            >
                                                {user.isFollowing ? 'Unfollow' : 'Follow'}
                                            </Button>
                                        </Box>
                                    )}
                                </Box>
                            </Box>
                        </Grid>
                        <Grid item xs={12} md={8}>
                            <Grid container spacing={2}>
                                <Grid item xs={6} sm={3}>
                                    <Paper variant="outlined" sx={{ p: 2, textAlign: 'center', borderRadius: 2 }}>
                                        <Typography variant="overline" color="text.secondary">
                                            Posts
                                        </Typography>
                                        <Typography variant="h4" sx={{ fontSize: '1.7rem' }}>
                                            {userStats.postCount}
                                        </Typography>
                                    </Paper>
                                </Grid>
                                <Grid item xs={6} sm={3}>
                                    <Paper variant="outlined" sx={{ p: 2, textAlign: 'center', borderRadius: 2 }}>
                                        <Typography variant="overline" color="text.secondary">
                                            Comments
                                        </Typography>
                                        <Typography variant="h4" sx={{ fontSize: '1.7rem' }}>
                                            {userStats.commentCount}
                                        </Typography>
                                    </Paper>
                                </Grid>
                                <Grid item xs={6} sm={3}>
                                    <Paper variant="outlined" sx={{ p: 2, textAlign: 'center', borderRadius: 2 }}>
                                        <Typography variant="overline" color="text.secondary">
                                            Followers
                                        </Typography>
                                        <Typography variant="h4" sx={{ fontSize: '1.7rem' }}>
                                            {user.followersCount || 0}
                                        </Typography>
                                    </Paper>
                                </Grid>
                                <Grid item xs={6} sm={3}>
                                    <Paper variant="outlined" sx={{ p: 2, textAlign: 'center', borderRadius: 2 }}>
                                        <Typography variant="overline" color="text.secondary">
                                            Following
                                        </Typography>
                                        <Typography variant="h4" sx={{ fontSize: '1.7rem' }}>
                                            {user.followingCount || 0}
                                        </Typography>
                                    </Paper>
                                </Grid>
                            </Grid>
                        </Grid>
                    </Grid>

                    <Divider sx={{ my: 3 }} />

                    <Grid container spacing={2} alignItems="center">
                        <Grid item xs={12} md={6}>
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
                        </Grid>
                        <Grid item xs={12} md={6}>
                            {isOwnProfile && user.role === 'admin' && (
                                <Box sx={{ display: 'flex', justifyContent: { xs: 'flex-start', md: 'flex-end' }, gap: 1, flexWrap: 'wrap' }}>
                                    <Button
                                        variant="outlined"
                                        startIcon={<DeveloperModeIcon />}
                                        onClick={() => navigate('/dev/api')}
                                    >
                                        API Dev Tools
                                    </Button>
                                    <Button
                                        variant="outlined"
                                        startIcon={<PsychologyIcon />}
                                        onClick={() => navigate('/dev/pod-context')}
                                    >
                                        Pod Context
                                    </Button>
                                </Box>
                            )}
                        </Grid>
                    </Grid>
                </CardContent>
            </Card>

            {/* Profile Tabs */}
            {isOwnProfile ? (
            <Card>
                <Tabs
                    value={currentTab}
                    onChange={(_e: React.SyntheticEvent, newValue: string) => setCurrentTab(newValue)}
                    sx={{ borderBottom: 1, borderColor: 'divider' }}
                >
                    <Tab value="overview" label="Overview" />
                    <Tab
                        value="apps"
                        label="Apps"
                        icon={<AppsIcon />}
                        iconPosition="start"
                    />
                    <Tab
                        value="api-token"
                        label="API Token"
                        icon={<KeyIcon />}
                        iconPosition="start"
                    />
                    {canManageUsers && (
                        <Tab
                            value="user-admin"
                            label="User Admin"
                            icon={<AdminPanelSettingsIcon />}
                            iconPosition="start"
                        />
                    )}
                </Tabs>

                <CardContent>
                    {currentTab === 'overview' && (
                        <Box>
                            <Typography variant="h6" gutterBottom>
                                Account Overview
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                                View your account statistics and recent activity here.
                            </Typography>
                        </Box>
                    )}

                    {currentTab === 'apps' && <AppsManagement />}

                    {currentTab === 'api-token' && (
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
                                        {new Date(apiTokenCreatedAt!).toLocaleDateString()} at {' '}
                                        {new Date(apiTokenCreatedAt!).toLocaleTimeString()}
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
                    {currentTab === 'user-admin' && canManageUsers && <AdminUsers embedded />}

                </CardContent>
            </Card>
            ) : (
            <Card>
                <CardContent>
                    <Typography variant="h6" gutterBottom>
                        Profile Overview
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                        This is a public profile view. Follow this user to get activity updates.
                    </Typography>
                    <Divider sx={{ my: 2 }} />
                    <Grid container spacing={2}>
                        <Grid item xs={12} md={6}>
                            <Typography variant="subtitle1" sx={{ mb: 1.25, fontWeight: 600 }}>
                                Recent Public Posts
                            </Typography>
                            {publicActivityLoading ? (
                                <Typography variant="body2" color="text.secondary">Loading…</Typography>
                            ) : publicActivity.recentPublicPosts.length === 0 ? (
                                <Typography variant="body2" color="text.secondary">No public posts yet.</Typography>
                            ) : (
                                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                                    {publicActivity.recentPublicPosts.map((post) => (
                                        <Paper
                                            key={post.id}
                                            variant="outlined"
                                            sx={{ p: 1.25, borderRadius: 2, cursor: 'pointer' }}
                                            onClick={() => navigate(`/thread/${post.id}`)}
                                        >
                                            <Typography variant="body2" sx={{ fontWeight: 500, mb: 0.5 }}>
                                                {(post.content || '').slice(0, 120) || '(No text)'}
                                            </Typography>
                                            <Typography variant="caption" color="text.secondary">
                                                {post.category || 'General'} • {formatDistanceToNow(new Date(post.createdAt), { addSuffix: true })}
                                            </Typography>
                                        </Paper>
                                    ))}
                                </Box>
                            )}
                        </Grid>
                        <Grid item xs={12} md={6}>
                            <Typography variant="subtitle1" sx={{ mb: 1.25, fontWeight: 600 }}>
                                Public Joined Pods
                            </Typography>
                            {publicActivityLoading ? (
                                <Typography variant="body2" color="text.secondary">Loading…</Typography>
                            ) : publicActivity.joinedPods.length === 0 ? (
                                <Typography variant="body2" color="text.secondary">No joined pods to show.</Typography>
                            ) : (
                                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                                    {publicActivity.joinedPods.map((pod) => (
                                        <Chip
                                            key={pod.id}
                                            clickable
                                            label={`${pod.name} (${pod.membersCount || 0})`}
                                            onClick={() => navigate(`/pods/${pod.type || 'chat'}/${pod.id}`)}
                                        />
                                    ))}
                                </Box>
                            )}
                        </Grid>
                    </Grid>
                </CardContent>
            </Card>
            )}

            {/* Avatar Selection Dialog */}
            {isOwnProfile && (
            <Dialog
                open={openAvatarDialog}
                onClose={handleCloseAvatarDialog}
                disableRestoreFocus={true}
            >
                <DialogTitle>Choose Your Avatar</DialogTitle>
                <DialogContent>
                    <Box sx={{ display: 'flex', justifyContent: 'center', mb: 2 }}>
                        <Avatar
                            sx={{
                                width: 72,
                                height: 72,
                                bgcolor: getAvatarColor(selectedAvatar),
                                fontSize: '1.6rem'
                            }}
                            src={avatarPreview || (isSelectedAvatarColor ? undefined : getAvatarSrc(selectedAvatar)) || undefined}
                        >
                            {user.username.charAt(0).toUpperCase()}
                        </Avatar>
                    </Box>
                    <Box sx={{ display: 'flex', justifyContent: 'center', mb: 2 }}>
                        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', justifyContent: 'center' }}>
                            <Button variant="outlined" component="label">
                                Upload image
                                <input
                                    type="file"
                                    accept="image/*"
                                    hidden
                                    onChange={handleAvatarFileChange}
                                />
                            </Button>
                            <Button
                                variant="outlined"
                                onClick={() => setAvatarGeneratorOpen(true)}
                            >
                                Generate with AI
                            </Button>
                        </Box>
                    </Box>
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
            )}

            {isOwnProfile && (
            <AvatarGenerator
                open={avatarGeneratorOpen}
                onClose={() => setAvatarGeneratorOpen(false)}
                onSelect={handleGeneratedAvatarSelect}
                agentName={user.username || 'user'}
                targetType="user"
            />
            )}

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
