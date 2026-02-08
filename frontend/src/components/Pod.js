/* eslint-disable max-len */
import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { 
    Container, Typography, Box, Grid, Card, CardContent, CardActions, 
    Button, TextField, Dialog, DialogTitle, DialogContent, DialogActions,
    FormControl, InputLabel, Select, MenuItem, CircularProgress, Tabs, Tab,
    AppBar, Toolbar, Avatar, Chip
} from '@mui/material';
import { 
    Add as AddIcon, 
    Search as SearchIcon,
    People as PeopleIcon,
    Launch as LaunchIcon
} from '@mui/icons-material';
import axios from 'axios';
import { useAuth } from '../context/AuthContext';
import { getAvatarColor, getAvatarSrc } from '../utils/avatarUtils';
import PodSummary from './PodSummary';
import './Pod.css';

const Pod = () => {
    const { currentUser } = useAuth();
    const [pods, setPods] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [openDialog, setOpenDialog] = useState(false);
    const [roomName, setRoomName] = useState('');
    const [roomDescription, setRoomDescription] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [tabValue, setTabValue] = useState(0);
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState(null);
    const [isDeleting, setIsDeleting] = useState(false);
    const [membershipFilter, setMembershipFilter] = useState('all');
    const [previewPod, setPreviewPod] = useState(null);
    const navigate = useNavigate();
    const { podType } = useParams();
    
    // Get pod type based on tab value or URL parameter - wrapped in useCallback
    const getPodType = useCallback(() => {
        if (podType) {
            return podType;
        }
        
        switch (tabValue) {
            case 0:
                return 'chat';
            case 1:
                return 'study';
            case 2:
                return 'games';
            case 3:
                return 'agent-ensemble';
            default:
                return 'chat';
        }
    }, [podType, tabValue]);
    
    // Set tab value based on URL parameter when component mounts
    useEffect(() => {
        if (podType) {
            switch (podType) {
                case 'chat':
                    setTabValue(0);
                    break;
                case 'study':
                    setTabValue(1);
                    break;
                case 'games':
                    setTabValue(2);
                    break;
                case 'agent-ensemble':
                    setTabValue(3);
                    break;
                default:
                    setTabValue(0);
            }
        }
    }, [podType]);
    
    // Fetch pods on component mount or when tab/podType changes
    useEffect(() => {
        const fetchPods = async () => {
            try {
                setLoading(true);
                const currentPodType = getPodType();
                
                const response = await axios.get(`/api/pods/${currentPodType}`);
                
                // Check if the response has data
                if (response.data && Array.isArray(response.data)) {
                    setPods(response.data);
                    setError(null);
                } else {
                    console.warn('Invalid pod data format received');
                    setPods([]);
                    setError('Failed to load pods: Invalid data format');
                }
            } catch (err) {
                console.error('Error fetching pods:', err);
                setPods([]);
                setError('Failed to load pods. Please try again later.');
            } finally {
                setLoading(false);
            }
        };
        
        fetchPods();
    }, [tabValue, podType, getPodType]);

    // Check if user is a member of a pod
    const isMember = useCallback((pod) => {
        if (!currentUser) return false;
        return pod.members && pod.members.some(member =>
            typeof member === 'object'
                ? member._id === currentUser._id
                : member === currentUser._id
        );
    }, [currentUser]);
    
    // Filter pods based on search query and tab value
    const filteredPods = React.useMemo(() => {
        const currentPodType = getPodType();
        return pods.filter(pod => {
            // Filter by pod type based on tab value
            const podTypeMatch = pod.type === currentPodType;
            
            // Filter by search query
            const podName = `${pod.name || ''}`.toLowerCase();
            const podDescription = `${pod.description || ''}`.toLowerCase();
            const normalizedQuery = searchQuery.toLowerCase();
            const searchMatch = podName.includes(normalizedQuery) || podDescription.includes(normalizedQuery);
            const joined = isMember(pod);
            const membershipMatch = membershipFilter === 'all'
                || (membershipFilter === 'joined' && joined)
                || (membershipFilter === 'discover' && !joined);
            
            return podTypeMatch && searchMatch && membershipMatch;
        });
    }, [pods, searchQuery, getPodType, membershipFilter, isMember]);

    const sortedPods = React.useMemo(() => {
        return [...filteredPods].sort((a, b) => {
            const aJoined = isMember(a);
            const bJoined = isMember(b);
            if (aJoined !== bJoined) return aJoined ? -1 : 1;
            return (b.members?.length || 0) - (a.members?.length || 0);
        });
    }, [filteredPods, isMember]);

    const joinedCount = React.useMemo(
        () => pods.filter((pod) => isMember(pod)).length,
        [pods, isMember]
    );
    
    // Handle creating a new room
    const handleCreateRoom = async () => {
        try {
            if (!roomName.trim()) {
                setError('Pod name is required');
                return;
            }
            
            // Get the pod type based on the selected tab
            const podTypes = ['chat', 'study', 'games', 'agent-ensemble'];
            const podType = podTypes[tabValue] || 'chat';
            
            const response = await axios.post('/api/pods', {
                name: roomName,
                description: roomDescription,
                type: podType
            }, {
                headers: {
                    'Authorization': `Bearer ${localStorage.getItem('token')}`
                }
            });
            
            // Add the new pod to the list
            setPods(prevPods => [...prevPods, response.data]);
            
            // Reset form and close dialog
            setOpenDialog(false);
            setRoomName('');
            setRoomDescription('');
            setError(null);
            
            // Refresh the pod list
            const fetchPods = async () => {
                try {
                    const response = await axios.get('/api/pods', {
                        params: { type: getPodType() }
                    });
                    setPods(response.data);
                } catch (err) {
                    console.error('Error fetching pods after creation:', err);
                }
            };
            
            fetchPods();
            
            // Navigate to the new pod
            navigate(`/pods/${podType}/${response.data._id}`);
        } catch (err) {
            console.error('Error creating pod:', err);
            setError('Failed to create pod. Please try again later.');
        }
    };

    const openDeleteDialog = (pod) => {
        setDeleteTarget(pod);
        setDeleteDialogOpen(true);
    };

    const closeDeleteDialog = () => {
        setDeleteDialogOpen(false);
        setDeleteTarget(null);
    };

    const handleDeletePod = async () => {
        if (!deleteTarget) return;
        setIsDeleting(true);
        try {
            await axios.delete(`/api/pods/${deleteTarget._id}`, {
                headers: {
                    'Authorization': `Bearer ${localStorage.getItem('token')}`
                }
            });
            setPods((prev) => prev.filter((pod) => pod._id !== deleteTarget._id));
            closeDeleteDialog();
        } catch (err) {
            console.error('Error deleting pod:', err);
            setError(err.response?.data?.msg || 'Failed to delete pod. Please try again.');
        } finally {
            setIsDeleting(false);
        }
    };
    
    // Handle joining a room
    const handleJoinRoom = async (podId) => {
        try {
            if (!podId) {
                console.error('Cannot join room: Invalid pod ID');
                setError('Cannot join room: Invalid pod ID');
                return;
            }
            
            const token = localStorage.getItem('token');
            
            // If user is already a member, navigate directly to the chat room
            const pod = pods.find(p => p._id === podId);
            if (pod && isMember(pod)) {
                navigate(`/pods/${getPodType()}/${podId}`);
                return;
            }
            
            // Otherwise, join the pod first
            const response = await axios.post(`/api/pods/${podId}/join`, {}, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            
            // Update the pod in the list
            setPods(pods.map(pod => pod._id === podId ? response.data : pod));
            
            // Navigate to the chat room
            navigate(`/pods/${getPodType()}/${podId}`);
        } catch (err) {
            console.error('Error joining room:', err);
            setError('Failed to join room. Please try again later.');
        }
    };
    
    // Handle tab change
    const handleTabChange = (event, newValue) => {
        setTabValue(newValue);
        const podTypes = ['chat', 'study', 'games', 'agent-ensemble'];
        navigate(`/pods/${podTypes[newValue]}`);
    };
    
    return (
        <Container
            maxWidth="lg"
            disableGutters
            sx={{ px: { xs: 2, sm: 3, md: 4 } }}
            className="pod-container"
        >
            <AppBar position="static" color="default" className="pod-app-bar">
                <Toolbar sx={{ flexWrap: { xs: 'wrap', sm: 'nowrap' }, gap: 1.5 }}>
                    <Box className="pod-header-title-wrap">
                        <Typography variant="h6" className="pod-title">
                            Pods
                        </Typography>
                        <Typography variant="body2" className="pod-subtitle">
                            Browse, preview, and join conversations before entering.
                        </Typography>
                    </Box>
                    <Box className="pod-stat-chips">
                        <Chip label={`${pods.length} total`} size="small" className="pod-stat-chip" />
                        <Chip label={`${joinedCount} joined`} size="small" className="pod-stat-chip" />
                        <Chip label={`${filteredPods.length} shown`} size="small" className="pod-stat-chip" />
                    </Box>
                    <Box sx={{ flexGrow: 1 }} />
                    <Box className="pod-search" sx={{ width: { xs: '100%', sm: 260 } }}>
                        <TextField
                            placeholder="Search pods..."
                            variant="outlined"
                            size="small"
                            fullWidth
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            InputProps={{
                                startAdornment: <SearchIcon color="action" />,
                            }}
                        />
                    </Box>
                    <Box sx={{ ml: { xs: 0, sm: 2 }, width: { xs: '100%', sm: 'auto' } }}>
                        <Button
                            fullWidth
                            variant="contained"
                            color="primary"
                            startIcon={<AddIcon />}
                            onClick={() => setOpenDialog(true)}
                            className="create-room-button"
                        >
                            Create Room
                        </Button>
                    </Box>
                </Toolbar>
                
                <Tabs
                    value={tabValue}
                    onChange={handleTabChange}
                    indicatorColor="primary"
                    textColor="primary"
                    centered
                    variant="scrollable"
                    allowScrollButtonsMobile
                    className="pod-tabs"
                >
                    <Tab label="Chat" className="pod-tab" />
                    <Tab label="Study" className="pod-tab" />
                    <Tab label="Games" className="pod-tab" />
                    <Tab label="Ensemble" className="pod-tab" />
                </Tabs>
                <Box className="pod-membership-filter-row">
                    <Button
                        size="small"
                        variant={membershipFilter === 'all' ? 'contained' : 'outlined'}
                        className="pod-filter-button"
                        onClick={() => setMembershipFilter('all')}
                    >
                        All
                    </Button>
                    <Button
                        size="small"
                        variant={membershipFilter === 'joined' ? 'contained' : 'outlined'}
                        className="pod-filter-button"
                        onClick={() => setMembershipFilter('joined')}
                    >
                        Joined
                    </Button>
                    <Button
                        size="small"
                        variant={membershipFilter === 'discover' ? 'contained' : 'outlined'}
                        className="pod-filter-button"
                        onClick={() => setMembershipFilter('discover')}
                    >
                        Discover
                    </Button>
                </Box>
            </AppBar>
            
            {loading ? (
                <Box className="pod-loading">
                    <CircularProgress />
                </Box>
            ) : error ? (
                <Box className="pod-error">
                    <Typography color="error">{error}</Typography>
                </Box>
            ) : (
                <Grid
                    container
                    spacing={{ xs: 0, sm: 3 }}
                    className="pod-grid"
                    sx={{ justifyContent: { xs: 'center', sm: 'flex-start' } }}
                >
                    {sortedPods.length === 0 ? (
                        <Grid item xs={12}>
                            <Box className="pod-empty">
                                <PeopleIcon sx={{ fontSize: 60, mb: 2 }} />
                                <Typography variant="h5" gutterBottom>
                                    No pods found in this category
                                </Typography>
                                <Typography variant="body1" color="textSecondary" paragraph>
                                    {getPodType() === 'agent-ensemble'
                                        ? 'Create a new agent ensemble pod to orchestrate multi-agent conversations.'
                                        : 'Create a new pod to start chatting with others!'}
                                </Typography>
                                <Button
                                    variant="contained"
                                    color="primary"
                                    size="large"
                                    startIcon={<AddIcon />}
                                    onClick={() => setOpenDialog(true)}
                                >
                                    Create New Pod
                                </Button>
                            </Box>
                        </Grid>
                    ) : (
                        sortedPods.map(pod => {
                            const canDeletePod = Boolean(currentUser && (
                                currentUser.role === 'admin'
                                || (pod.createdBy && pod.createdBy._id === currentUser._id)
                            ));
                            const joined = isMember(pod);
                            const creatorAvatarSrc = getAvatarSrc(pod.createdBy?.profilePicture);
                            return (
                            <Grid item xs={12} sm={6} md={4} key={pod._id}>
                                <Card className="pod-card">
                                    <CardContent sx={{ p: 2, pb: 1.5 }}>
                                        <Box className="pod-card-meta">
                                            <Chip
                                                size="small"
                                                className="pod-card-type-chip"
                                                label={(pod.type || getPodType()).replace('-', ' ')}
                                            />
                                            {joined ? (
                                                <Chip size="small" className="pod-card-joined-chip" label="Joined" />
                                            ) : null}
                                        </Box>
                                        <Typography variant="h5" component="div" className="pod-card-title">
                                            {pod.name}
                                        </Typography>
                                        
                                        {/* AI Summary only - no redundant description */}
                                        <PodSummary 
                                            podId={pod._id} 
                                            podName={pod.name} 
                                            podType={getPodType()} 
                                            originalDescription={pod.description}
                                        />
                                        
                                        <Box className="pod-card-footer">
                                        <Box className="pod-card-creator">
                                            <Avatar 
                                                className="pod-creator-avatar"
                                                    src={creatorAvatarSrc || undefined}
                                                    sx={{ 
                                                        bgcolor: getAvatarColor(pod.createdBy?.profilePicture || 'default'),
                                                        color: 'white',
                                                        width: 28,
                                                        height: 28,
                                                        fontSize: '0.875rem'
                                                    }}
                                            >
                                                {pod.createdBy?.username?.charAt(0).toUpperCase()}
                                            </Avatar>
                                                <Typography variant="body2" className="creator-text">
                                                    @{pod.createdBy?.username}
                                            </Typography>
                                        </Box>
                                        <Box className="pod-card-members">
                                                <PeopleIcon />
                                                <Typography variant="body2" className="member-count">
                                                    {pod.members?.length || 0}
                                            </Typography>
                                            </Box>
                                        </Box>
                                    </CardContent>
                                    <CardActions className="pod-card-actions" sx={{ px: 2, py: 1.5 }}>
                                        <Button
                                            variant="outlined"
                                            color="inherit"
                                            onClick={() => setPreviewPod(pod)}
                                            startIcon={<LaunchIcon />}
                                        >
                                            Preview
                                        </Button>
                                        <Button 
                                            variant="contained" 
                                            color="primary"
                                            fullWidth={!canDeletePod}
                                            onClick={() => handleJoinRoom(pod._id)}
                                        >
                                            {joined ? 'Open Chat' : 'Join Room'}
                                        </Button>
                                        {canDeletePod && (
                                            <Button
                                                variant="text"
                                                color="error"
                                                onClick={() => openDeleteDialog(pod)}
                                            >
                                                Delete
                                            </Button>
                                        )}
                                    </CardActions>
                                </Card>
                            </Grid>
                            );
                        })
                    )}
                </Grid>
            )}
            
            {/* Create Room Dialog */}
            <Dialog open={openDialog} onClose={() => setOpenDialog(false)} maxWidth="sm" fullWidth>
                <DialogTitle>
                    <Box display="flex" alignItems="center">
                        <AddIcon sx={{ mr: 1, color: 'primary.main' }} />
                        Create a New Pod
                    </Box>
                </DialogTitle>
                <DialogContent>
                    <Typography variant="body2" color="textSecondary" sx={{ mb: 2 }}>
                        Create a new pod to chat with others. Pods are spaces where you can discuss topics, share ideas, and connect with people.
                    </Typography>
                    <TextField
                        autoFocus
                        margin="dense"
                        label="Pod Name"
                        type="text"
                        fullWidth
                        value={roomName}
                        onChange={(e) => setRoomName(e.target.value)}
                        sx={{ mb: 2 }}
                        placeholder="E.g., JavaScript Developers, Book Club, etc."
                    />
                    <TextField
                        margin="dense"
                        label="Description"
                        type="text"
                        fullWidth
                        multiline
                        rows={3}
                        value={roomDescription}
                        onChange={(e) => setRoomDescription(e.target.value)}
                        sx={{ mb: 2 }}
                        placeholder="Describe what this pod is about..."
                    />
                    <FormControl fullWidth sx={{ mb: 2 }}>
                        <InputLabel>Pod Type</InputLabel>
                        <Select
                            value={tabValue}
                            onChange={(e) => setTabValue(Number(e.target.value))}
                        >
                            <MenuItem value={0}>Chat</MenuItem>
                            <MenuItem value={1}>Study</MenuItem>
                            <MenuItem value={2}>Games</MenuItem>
                            <MenuItem value={3}>Agent Ensemble</MenuItem>
                        </Select>
                    </FormControl>
                </DialogContent>
                <DialogActions sx={{ px: 3, pb: 3 }}>
                    <Button onClick={() => setOpenDialog(false)} color="inherit" variant="outlined">
                        Cancel
                    </Button>
                    <Button 
                        onClick={handleCreateRoom} 
                        color="primary" 
                        variant="contained"
                        disabled={!roomName.trim()}
                    >
                        Create Pod
                    </Button>
                </DialogActions>
            </Dialog>

            <Dialog
                open={Boolean(previewPod)}
                onClose={() => setPreviewPod(null)}
                maxWidth="sm"
                fullWidth
            >
                <DialogTitle>{previewPod?.name || 'Pod Preview'}</DialogTitle>
                <DialogContent>
                    <Box className="pod-preview-body">
                        <Typography variant="body2" color="textSecondary">
                            {previewPod?.description || 'No description yet.'}
                        </Typography>
                        <Box className="pod-preview-meta">
                            <Chip
                                size="small"
                                label={`Type: ${(previewPod?.type || '').replace('-', ' ') || getPodType()}`}
                            />
                            <Chip
                                size="small"
                                icon={<PeopleIcon />}
                                label={`${previewPod?.members?.length || 0} members`}
                            />
                            <Chip
                                size="small"
                                label={`Creator: @${previewPod?.createdBy?.username || 'unknown'}`}
                            />
                        </Box>
                    </Box>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setPreviewPod(null)}>Close</Button>
                    <Button
                        color="primary"
                        variant="contained"
                        onClick={() => {
                            if (!previewPod?._id) return;
                            handleJoinRoom(previewPod._id);
                            setPreviewPod(null);
                        }}
                    >
                        {previewPod && isMember(previewPod) ? 'Open from Preview' : 'Join from Preview'}
                    </Button>
                </DialogActions>
            </Dialog>

            <Dialog open={deleteDialogOpen} onClose={closeDeleteDialog}>
                <DialogTitle>Delete Pod</DialogTitle>
                <DialogContent>
                    <Typography>
                        Delete &quot;{deleteTarget?.name}&quot;? This will remove messages, assets, and agent installs for the pod.
                    </Typography>
                </DialogContent>
                <DialogActions>
                    <Button onClick={closeDeleteDialog}>Cancel</Button>
                    <Button color="error" variant="contained" onClick={handleDeletePod} disabled={isDeleting}>
                        {isDeleting ? 'Deleting...' : 'Delete'}
                    </Button>
                </DialogActions>
            </Dialog>
        </Container>
    );
};

export default Pod; 
