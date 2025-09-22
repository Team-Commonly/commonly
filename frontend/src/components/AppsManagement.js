import React, { useState, useEffect, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import {
    Box,
    Typography,
    Card,
    CardContent,
    CardActions,
    Button,
    Chip,
    Alert,
    CircularProgress,
    Dialog,
    DialogTitle,
    DialogContent,
    DialogActions,
    Grid,
    IconButton,
    Tooltip,
} from '@mui/material';
import {
    Delete as DeleteIcon,
    Refresh as RefreshIcon,
    Settings as SettingsIcon,
} from '@mui/icons-material';
import { AuthContext } from '../context/AuthContext';

const AppsManagement = () => {
    const { user } = useContext(AuthContext);
    const navigate = useNavigate();
    const [integrations, setIntegrations] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [selectedIntegration, setSelectedIntegration] = useState(null);
    const [deleting, setDeleting] = useState(false);

    const fetchIntegrations = async () => {
        try {
            setLoading(true);
            const token = localStorage.getItem('token');
            
            // Fetch user's integrations or all integrations if admin
            const endpoint = user?.role === 'admin' 
                ? '/api/integrations/admin/all'
                : '/api/integrations/user/all';
                
            const response = await axios.get(endpoint, {
                headers: { Authorization: `Bearer ${token}` }
            });
            
            setIntegrations(response.data);
            setError('');
        } catch (err) {
            console.error('Error fetching integrations:', err);
            setError('Failed to load integrations');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchIntegrations();
    }, [user]);

    const handleDeleteClick = (integration) => {
        setSelectedIntegration(integration);
        setDeleteDialogOpen(true);
    };

    const handleDeleteConfirm = async () => {
        if (!selectedIntegration) return;

        setDeleting(true);
        try {
            const token = localStorage.getItem('token');
            await axios.delete(`/api/integrations/${selectedIntegration._id}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            
            // Remove from local state
            setIntegrations(prev => prev.filter(int => int._id !== selectedIntegration._id));
            setError('');
            setDeleteDialogOpen(false);
            setSelectedIntegration(null);
        } catch (err) {
            console.error('Error deleting integration:', err);
            setError(err.response?.data?.message || 'Failed to delete integration');
        } finally {
            setDeleting(false);
        }
    };

    const getStatusColor = (status) => {
        switch (status) {
            case 'connected': return 'success';
            case 'disconnected': return 'warning';
            case 'error': return 'error';
            case 'pending': return 'info';
            default: return 'default';
        }
    };

    const getTypeIcon = (type) => {
        switch (type) {
            case 'discord': return '💬';
            case 'telegram': return '✈️';
            case 'slack': return '💬';
            case 'messenger': return '📩';
            default: return '🔗';
        }
    };

    if (loading) {
        return (
            <Box display="flex" justifyContent="center" alignItems="center" minHeight={200}>
                <CircularProgress />
            </Box>
        );
    }

    return (
        <Box>
            <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
                <Typography variant="h5">
                    App Integrations {user?.role === 'admin' && '(Admin View)'}
                </Typography>
                <Tooltip title="Refresh">
                    <IconButton onClick={fetchIntegrations} disabled={loading}>
                        <RefreshIcon />
                    </IconButton>
                </Tooltip>
            </Box>

            {error && (
                <Alert severity="error" sx={{ mb: 3 }}>
                    {error}
                </Alert>
            )}

            {integrations.length === 0 ? (
                <Alert severity="info">
                    No app integrations found. Create integrations from within your pods.
                </Alert>
            ) : (
                <Grid container spacing={3}>
                    {integrations.map((integration) => (
                        <Grid item xs={12} md={6} lg={4} key={integration._id}>
                            <Card>
                                <CardContent>
                                    <Box display="flex" alignItems="center" mb={2}>
                                        <Typography variant="h6" sx={{ mr: 1 }}>
                                            {getTypeIcon(integration.type)} {integration.type}
                                        </Typography>
                                        <Chip 
                                            label={integration.status}
                                            color={getStatusColor(integration.status)}
                                            size="small"
                                        />
                                    </Box>
                                    
                                    <Typography variant="body2" color="text.secondary" gutterBottom>
                                        Pod: {integration.podId?.name || 'Unknown Pod'}
                                    </Typography>
                                    
                                    {user?.role === 'admin' && (
                                        <Typography variant="body2" color="text.secondary" gutterBottom>
                                            Created by: {integration.createdBy?.username || 'Unknown User'}
                                        </Typography>
                                    )}
                                    
                                    {integration.config?.serverName && (
                                        <Typography variant="body2" color="text.secondary" gutterBottom>
                                            Server: {integration.config.serverName}
                                        </Typography>
                                    )}
                                    
                                    {integration.config?.channelName && (
                                        <Typography variant="body2" color="text.secondary" gutterBottom>
                                            Channel: #{integration.config.channelName}
                                        </Typography>
                                    )}
                                    
                                    <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                                        Created: {new Date(integration.createdAt).toLocaleDateString()}
                                    </Typography>
                                </CardContent>
                                
                                <CardActions>
                                    <Button
                                        size="small"
                                        startIcon={<SettingsIcon />}
                                        onClick={() => {
                                            // Navigate to pod with correct type and roomId
                                            const podType = integration.podId?.type || 'chat';
                                            const roomId = integration.podId?._id;
                                            if (roomId) {
                                                navigate(`/pods/${podType}/${roomId}`);
                                            }
                                        }}
                                    >
                                        Manage
                                    </Button>
                                    
                                    <Button
                                        size="small"
                                        color="error"
                                        startIcon={<DeleteIcon />}
                                        onClick={() => handleDeleteClick(integration)}
                                    >
                                        Delete
                                    </Button>
                                </CardActions>
                            </Card>
                        </Grid>
                    ))}
                </Grid>
            )}

            {/* Delete Confirmation Dialog */}
            <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)}>
                <DialogTitle>Delete Integration</DialogTitle>
                <DialogContent>
                    <Typography>
                        Are you sure you want to delete the {selectedIntegration?.type} integration 
                        for &quot;{selectedIntegration?.podId?.name}&quot;? This action cannot be undone.
                    </Typography>
                    {selectedIntegration?.config?.serverName && (
                        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                            Server: {selectedIntegration.config.serverName}
                        </Typography>
                    )}
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setDeleteDialogOpen(false)} disabled={deleting}>
                        Cancel
                    </Button>
                    <Button 
                        onClick={handleDeleteConfirm} 
                        color="error" 
                        disabled={deleting}
                        startIcon={deleting ? <CircularProgress size={16} /> : <DeleteIcon />}
                    >
                        {deleting ? 'Deleting...' : 'Delete'}
                    </Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
};

export default AppsManagement;