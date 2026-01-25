import React, { useState, useEffect, useContext } from 'react';
import {
  Box,
  Button,
  Typography,
  Alert,
  CircularProgress,
  Card,
  CardContent,
  Chip,
  IconButton,
  Tooltip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions
} from '@mui/material';
import {
  Add as AddIcon,
  Refresh as RefreshIcon,
  Delete as DeleteIcon
} from '@mui/icons-material';
import axios from 'axios';
import { AuthContext } from '../context/AuthContext';

// Discord logo component
const DiscordIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
    <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419-.0190 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9460 2.4189-2.1568 2.4189Z"/>
  </svg>
);

// Use OAuth flow with redirect instead of simple bot invite
const getDiscordOAuthUrl = (podId) => {
  const clientId = process.env.REACT_APP_DISCORD_CLIENT_ID;
  const redirectUri = encodeURIComponent(`${process.env.REACT_APP_API_URL}/api/discord/callback`);
  const scopes = encodeURIComponent('bot applications.commands');
  const permissions = '536873984'; // Send Messages (2048) + Manage Webhooks (536870912) = 536873984
  const state = `pod_${podId}`;
  const timestamp = Date.now(); // Add timestamp to prevent caching
  
  return `https://discord.com/api/oauth2/authorize?client_id=${clientId}&scope=${scopes}&permissions=${permissions}&redirect_uri=${redirectUri}&response_type=code&state=${state}&t=${timestamp}`;
};

const DiscordIntegration = ({ podId, viewOnly = false }) => {
  const { user } = useContext(AuthContext);
  const [integrations, setIntegrations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [integrationToDelete, setIntegrationToDelete] = useState(null);
  const [podInfo, setPodInfo] = useState(null);

  // Check if user can delete integration (only used in non-viewOnly mode)
  const canDeleteIntegration = (integration) => {
    if (viewOnly) return false; // No delete in view-only mode
    
    if (!user) return false;
    
    // Admin can delete any integration
    if (user.role === 'admin') return true;
    
    // Get user ID (different auth contexts use different field names)
    const currentUserId = user.id || user._id;
    
    // Pod owner can delete integrations in their pod
    if (podInfo) {
      const podOwnerId = typeof podInfo.createdBy === 'string' ? podInfo.createdBy : podInfo.createdBy?._id;
      if (podOwnerId === currentUserId) return true;
    }
    
    // Integration creator can delete their own integration
    const integrationCreatorId = integration.createdBy?._id || integration.createdBy;
    if (integrationCreatorId === currentUserId) return true;
    
    return false;
  };

  // Fetch existing integrations and pod info
  const fetchIntegrations = async () => {
    try {
      setLoading(true);
      const token = localStorage.getItem('token');
      
      // Fetch integrations and pod info in parallel
      const [integrationsResponse, podResponse] = await Promise.all([
        axios.get(`/api/integrations/${podId}`, {
          headers: { Authorization: `Bearer ${token}` }
        }),
        axios.get(`/api/pods/${podId}`, {
          headers: { Authorization: `Bearer ${token}` }
        }).catch((error) => {
          console.warn('Pod fetch failed:', error.response?.status, error.response?.data);
          return null; // Don't fail if pod info can't be fetched
        })
      ]);
      
      const discordIntegrations = integrationsResponse.data.filter(integration => integration.type === 'discord');
      setIntegrations(discordIntegrations);
      
      if (podResponse) {
        setPodInfo(podResponse.data);
      }
    } catch (error) {
      console.error('Error fetching integrations:', error);
      setError('Failed to load apps');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (podId) {
      fetchIntegrations();
    }
  }, [podId]);

  const handleDelete = async (integrationId) => {
    try {
      setLoading(true);
      const token = localStorage.getItem('token');
      await axios.delete(`/api/integrations/${integrationId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      setSuccess('App disconnected successfully');
      fetchIntegrations();
      setDeleteDialogOpen(false);
      setIntegrationToDelete(null);
    } catch (error) {
      console.error('Error deleting integration:', error);
      setError('Failed to disconnect app');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteClick = (integration) => {
    setIntegrationToDelete(integration);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = () => {
    if (integrationToDelete) {
      handleDelete(integrationToDelete._id);
    }
  };

  const handleDeleteCancel = () => {
    setDeleteDialogOpen(false);
    setIntegrationToDelete(null);
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'connected': return 'success';
      case 'pending': return 'warning';
      case 'error': return 'error';
      default: return 'default';
    }
  };

  const getStatusText = (status) => {
    switch (status) {
      case 'connected': return 'Connected';
      case 'pending': return 'Connecting...';
      case 'error': return 'Error';
      default: return 'Unknown';
    }
  };

  if (loading && integrations.length === 0) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
        <CircularProgress size={24} />
      </Box>
    );
  }

  return (
    <Box sx={{ p: 0 }}>
      {/* Header removed - title is already in sidebar section */}
      
      {/* Error/Success Messages */}
      {error && (
        <Alert 
          severity="error" 
          sx={{ mb: 2, borderRadius: 2 }} 
          onClose={() => setError('')}
        >
          {error}
        </Alert>
      )}
      {success && (
        <Alert 
          severity="success" 
          sx={{ mb: 2, borderRadius: 2 }} 
          onClose={() => setSuccess('')}
        >
          {success}
        </Alert>
      )}

      {/* Apps List */}
      {integrations.length === 0 ? (
        <Card 
          sx={{ 
            borderRadius: 3,
            border: '1px solid rgba(88, 101, 242, 0.1)',
            background: 'linear-gradient(135deg, #ffffff 0%, #f8f9ff 100%)',
            '&:hover': {
              transform: 'translateY(-2px)',
              boxShadow: '0 8px 25px rgba(88, 101, 242, 0.15)',
              borderColor: 'rgba(88, 101, 242, 0.2)'
            },
            transition: 'all 0.3s ease'
          }}
        >
          <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                <Box 
                  sx={{ 
                    color: '#5865F2',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 32,
                    height: 32,
                    backgroundColor: 'rgba(88, 101, 242, 0.1)',
                    borderRadius: 2
                  }}
                >
                  <DiscordIcon />
                </Box>
                <Box>
                  <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 0.5 }}>
                    Discord
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    Connect Discord to sync messages with your server.
                  </Typography>
                </Box>
              </Box>
              <Button
                variant="contained"
                size="small"
                startIcon={<AddIcon fontSize="small" />}
                href={getDiscordOAuthUrl(podId)}
                target="_blank"
                rel="noopener noreferrer"
                disabled={loading}
                sx={{
                  borderRadius: 2,
                  textTransform: 'none',
                  fontWeight: 600,
                  backgroundColor: '#5865F2',
                  boxShadow: 'none',
                  '&:hover': {
                    backgroundColor: '#4752C4',
                    transform: 'translateY(-1px)',
                    boxShadow: '0 4px 12px rgba(88, 101, 242, 0.3)'
                  },
                  transition: 'all 0.2s ease'
                }}
              >
                Add Discord
              </Button>
            </Box>
          </CardContent>
        </Card>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {/* Add Discord button for existing integrations */}
          <Button
            variant="contained"
            size="small"
            startIcon={<AddIcon />}
            href={getDiscordOAuthUrl(podId)}
            target="_blank"
            rel="noopener noreferrer"
            disabled={loading}
            fullWidth
            sx={{
              borderRadius: 2,
              textTransform: 'none',
              fontWeight: 600,
              background: 'linear-gradient(45deg, #5865F2 30%, #7289DA 90%)',
              '&:hover': {
                background: 'linear-gradient(45deg, #4752C4 30%, #5B6DA8 90%)',
                transform: 'translateY(-1px)',
                boxShadow: '0 4px 12px rgba(88, 101, 242, 0.3)'
              },
              transition: 'all 0.2s ease'
            }}
          >
            Add Discord
          </Button>
          
          {integrations.map((integration) => (
            <Card 
              key={integration._id} 
              sx={{ 
                borderRadius: 3,
                border: '1px solid rgba(88, 101, 242, 0.1)',
                background: 'linear-gradient(135deg, #ffffff 0%, #f8f9ff 100%)',
                '&:hover': {
                  transform: 'translateY(-2px)',
                  boxShadow: '0 8px 25px rgba(88, 101, 242, 0.15)',
                  borderColor: 'rgba(88, 101, 242, 0.2)'
                },
                transition: 'all 0.3s ease'
              }}
            >
              <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                    <Box 
                      sx={{ 
                        color: '#5865F2',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 32,
                        height: 32,
                        backgroundColor: 'rgba(88, 101, 242, 0.1)',
                        borderRadius: 2
                      }}
                    >
                      <DiscordIcon />
                    </Box>
                    <Box>
                      <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 0.5 }}>
                        {integration.config?.serverName || 'Discord Server'}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        #{integration.config?.channelName || 'channel'}
                      </Typography>
                    </Box>
                  </Box>
                  
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Chip 
                      label={getStatusText(integration.status)}
                      size="small"
                      color={getStatusColor(integration.status)}
                      variant={integration.status === 'connected' ? 'filled' : 'outlined'}
                      sx={{
                        fontWeight: 500,
                        borderRadius: 2
                      }}
                    />
                    
                    <Tooltip title="Refresh">
                      <IconButton
                        size="small"
                        onClick={fetchIntegrations}
                        disabled={loading}
                        sx={{ 
                          color: 'text.secondary',
                          '&:hover': { 
                            color: '#5865F2',
                            backgroundColor: 'rgba(88, 101, 242, 0.1)'
                          }
                        }}
                      >
                        <RefreshIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    
                    {!viewOnly && (
                      <Tooltip title={canDeleteIntegration(integration) ? "Delete Integration" : "No permission to delete"}>
                        <IconButton
                          size="small"
                          onClick={() => {
                            if (canDeleteIntegration(integration)) {
                              handleDeleteClick(integration);
                            }
                          }}
                          disabled={loading || !canDeleteIntegration(integration)}
                          sx={{ 
                            color: canDeleteIntegration(integration) ? 'error.main' : 'text.disabled',
                            opacity: canDeleteIntegration(integration) ? 0.8 : 0.4,
                            '&:hover': { 
                              opacity: canDeleteIntegration(integration) ? 1 : 0.4,
                              color: canDeleteIntegration(integration) ? 'error.dark' : 'text.disabled',
                              backgroundColor: canDeleteIntegration(integration) ? 'rgba(244, 67, 54, 0.1)' : 'transparent',
                              transform: canDeleteIntegration(integration) ? 'scale(1.1)' : 'none'
                            },
                            transition: 'all 0.2s ease'
                          }}
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                  </Box>
                </Box>
              </CardContent>
            </Card>
          ))}
        </Box>
      )}

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onClose={handleDeleteCancel}>
        <DialogTitle>Remove Discord Integration?</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to remove the Discord integration for{' '}
            <strong>{integrationToDelete?.config?.serverName}</strong>?
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            This will disconnect the bot from your Discord server and stop all message syncing.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleDeleteCancel}>Cancel</Button>
          <Button 
            onClick={handleDeleteConfirm} 
            color="error" 
            disabled={loading}
          >
            {loading ? <CircularProgress size={20} /> : 'Remove'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default DiscordIntegration; 
