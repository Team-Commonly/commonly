import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { 
    Container, Typography, Box, Grid, Card, CardContent, CardActions, 
    Button, TextField, Dialog, DialogTitle, DialogContent, DialogActions,
    FormControl, InputLabel, Select, MenuItem, CircularProgress, Tabs, Tab,
    AppBar, Toolbar, IconButton, Badge, Avatar, FormControlLabel, Switch
} from '@mui/material';
import { 
    Add as AddIcon, 
    Search as SearchIcon,
    People as PeopleIcon 
} from '@mui/icons-material';
import axios from 'axios';
import { useSocket } from '../context/SocketContext';
import { useAuth } from '../context/AuthContext';
import { getAvatarColor } from '../utils/avatarUtils';
import './Pod.css';

const Pod = () => {
    const { pgAvailable } = useSocket();
    const { currentUser } = useAuth();
    const [pods, setPods] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [openDialog, setOpenDialog] = useState(false);
    const [roomName, setRoomName] = useState('');
    const [roomDescription, setRoomDescription] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [tabValue, setTabValue] = useState(0);
    const navigate = useNavigate();
    const { podType } = useParams();
    
    // Get pod type based on tab value or URL parameter
    const getPodType = () => {
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
            default:
                return 'chat';
        }
    };
    
    // Fetch pods on component mount
    useEffect(() => {
        const fetchPods = async () => {
            try {
                setLoading(true);
                const response = await axios.get('/api/pods', {
                    params: { type: getPodType() }
                });
                setPods(response.data);
                setError(null);
            } catch (err) {
                console.error('Error fetching pods:', err);
                setError('Failed to load pods. Please try again later.');
            } finally {
                setLoading(false);
            }
        };
        
        fetchPods();
    }, []);
    
    // Filter pods based on search query and tab value
    const filteredPods = React.useMemo(() => {
        const currentPodType = getPodType();
        return pods.filter(pod => {
            // Filter by pod type based on tab value
            const podTypeMatch = pod.type === currentPodType;
            
            // Filter by search query
            const searchMatch = pod.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                               pod.description.toLowerCase().includes(searchQuery.toLowerCase());
            
            return podTypeMatch && searchMatch;
        });
    }, [pods, tabValue, searchQuery]);
    
    // Handle creating a new room
    const handleCreateRoom = async () => {
        try {
            if (!roomName.trim()) {
                setError('Pod name is required');
                return;
            }
            
            // Get the pod type based on the selected tab
            const podTypes = ['chat', 'study', 'games'];
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
            setPods([...pods, response.data]);
            
            // Reset form and close dialog
            setOpenDialog(false);
            setRoomName('');
            setRoomDescription('');
            setError(null);
            
            // Show success message or navigate to the new pod
            // navigate(`/pods/${podType}/${response.data._id}`);
        } catch (err) {
            console.error('Error creating pod:', err);
            setError('Failed to create pod. Please try again later.');
        }
    };
    
    // Handle joining a room
    const handleJoinRoom = async (podId) => {
        try {
            const response = await axios.post(`/api/pods/${podId}/join`);
            
            // Update the pod in the list
            setPods(pods.map(pod => pod._id === podId ? response.data : pod));
            
            // Navigate to the chat room
            navigate(`/pods/${getPodType()}/${podId}`);
        } catch (err) {
            console.error('Error joining room:', err);
            setError('Failed to join room. Please try again later.');
        }
    };
    
    // Check if user is a member of a pod
    const isMember = (pod) => {
        if (pgAvailable) {
            return pod.members && pod.members.includes(currentUser._id);
        } else {
            return pod.members && pod.members.includes(currentUser._id);
        }
    };
    
    return (
        <Container maxWidth="lg" className="pod-container">
            <AppBar position="static" color="default" className="pod-app-bar">
                <Toolbar>
                    <Typography variant="h6" className="pod-title">
                        Pods
                    </Typography>
                    <Box sx={{ flexGrow: 1 }} />
                    <Box className="pod-search">
                        <TextField
                            placeholder="Search pods..."
                            variant="outlined"
                            size="small"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            InputProps={{
                                startAdornment: <SearchIcon color="action" />,
                            }}
                        />
                    </Box>
                    <Box sx={{ ml: 2 }}>
                        <Button
                            variant="contained"
                            color="primary"
                            startIcon={<AddIcon />}
                            onClick={() => setOpenDialog(true)}
                        >
                            Create Room
                        </Button>
                    </Box>
                </Toolbar>
                
                <Tabs
                    value={tabValue}
                    onChange={(e, newValue) => setTabValue(newValue)}
                    indicatorColor="primary"
                    textColor="primary"
                    centered
                >
                    <Tab label="Chat" />
                    <Tab label="Study" />
                    <Tab label="Games" />
                </Tabs>
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
                <Grid container spacing={3} className="pod-grid">
                    {filteredPods.length === 0 ? (
                        <Grid item xs={12}>
                            <Box className="pod-empty" sx={{ 
                                display: 'flex', 
                                flexDirection: 'column', 
                                alignItems: 'center', 
                                justifyContent: 'center',
                                padding: 4,
                                textAlign: 'center',
                                backgroundColor: '#f5f5f5',
                                borderRadius: 2,
                                marginTop: 4
                            }}>
                                <PeopleIcon sx={{ fontSize: 60, color: 'primary.main', mb: 2 }} />
                                <Typography variant="h5" gutterBottom>
                                    No pods found in this category
                                </Typography>
                                <Typography variant="body1" color="textSecondary" paragraph>
                                    Create a new pod to start chatting with others!
                                </Typography>
                                <Button
                                    variant="contained"
                                    color="primary"
                                    size="large"
                                    startIcon={<AddIcon />}
                                    onClick={() => setOpenDialog(true)}
                                    sx={{ mt: 2 }}
                                >
                                    Create New Pod
                                </Button>
                            </Box>
                        </Grid>
                    ) : (
                        filteredPods.map(pod => (
                            <Grid item xs={12} sm={6} md={4} key={pod._id}>
                                <Card className="pod-card">
                                    <CardContent>
                                        <Typography variant="h5" component="div" className="pod-card-title">
                                            {pod.name}
                                        </Typography>
                                        <Typography variant="body2" color="text.secondary" className="pod-card-description">
                                            {pod.description}
                                        </Typography>
                                        <Box className="pod-card-creator">
                                            <Avatar 
                                                className="pod-creator-avatar"
                                                src={pod.createdBy?.profilePicture}
                                                sx={{ bgcolor: getAvatarColor(pod.createdBy?.username || '') }}
                                            >
                                                {pod.createdBy?.username?.charAt(0).toUpperCase()}
                                            </Avatar>
                                            <Typography variant="body2">
                                                Created by: {pod.createdBy?.username}
                                            </Typography>
                                        </Box>
                                        <Box className="pod-card-members">
                                            <Badge badgeContent={pod.members?.length || 0} color="primary">
                                                <PeopleIcon />
                                            </Badge>
                                            <Typography variant="body2">
                                                {pod.members?.length || 0} members
                                            </Typography>
                                        </Box>
                                    </CardContent>
                                    <CardActions className="pod-card-actions">
                                        <Button 
                                            variant="contained" 
                                            color="primary"
                                            fullWidth
                                            onClick={() => handleJoinRoom(pod._id)}
                                        >
                                            {isMember(pod) ? 'Enter Room' : 'Join Room'}
                                        </Button>
                                    </CardActions>
                                </Card>
                            </Grid>
                        ))
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
                            onChange={(e) => setTabValue(e.target.value)}
                        >
                            <MenuItem value={0}>Chat</MenuItem>
                            <MenuItem value={1}>Study</MenuItem>
                            <MenuItem value={2}>Games</MenuItem>
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
        </Container>
    );
};

export default Pod; 