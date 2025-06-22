import React, { useState, useEffect } from 'react';
import {
  Box,
  Button,
  TextField,
  Typography,
  Paper,
  Alert,
  CircularProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  List,
  ListItem,
  ListItemText,
  ListItemSecondaryAction,
  IconButton,
  Chip,
  Link
} from '@mui/material';
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  Refresh as RefreshIcon,
  CheckCircle as CheckCircleIcon,
  Error as ErrorIcon,
  Link as LinkIcon,
  Launch as LaunchIcon
} from '@mui/icons-material';
import axios from 'axios';

const COMMONLY_BOT_INVITE_URL = 'https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=536870912&scope=bot'; // Replace with actual bot invite URL

const DiscordIntegration = ({ podId }) => {
  const [integrations, setIntegrations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [openDialog, setOpenDialog] = useState(false);
  const [formData, setFormData] = useState({
    serverId: '',
    serverName: '',
    channelId: '',
    channelName: ''
  });

  // Fetch existing integrations
  const fetchIntegrations = async () => {
    try {
      setLoading(true);
      const token = localStorage.getItem('token');
      const response = await axios.get(`/api/integrations/${podId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      const discordIntegrations = response.data.filter(integration => integration.type === 'discord');
      setIntegrations(discordIntegrations);
    } catch (error) {
      console.error('Error fetching integrations:', error);
      setError('Failed to fetch integrations');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (podId) {
      fetchIntegrations();
    }
  }, [podId]);

  // Handle form submission
  const handleSubmit = async (e) => {
    e.preventDefault();
    
    try {
      setLoading(true);
      setError('');
      setSuccess('');
      
      const token = localStorage.getItem('token');
      const response = await axios.post('/api/discord/integration', {
        podId,
        ...formData
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      setSuccess('Discord integration created successfully!');
      setOpenDialog(false);
      setFormData({
        serverId: '',
        serverName: '',
        channelId: '',
        channelName: ''
      });
      
      // Refresh integrations list
      fetchIntegrations();
    } catch (error) {
      console.error('Error creating Discord integration:', error);
      if (error.response?.data?.code === 'BOT_NOT_IN_SERVER') {
        setError('Please add the Commonly bot to your Discord server first');
      } else {
        setError(error.response?.data?.message || 'Failed to create integration');
      }
    } finally {
      setLoading(false);
    }
  };

  // Handle form input changes
  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
  };

  // Delete integration
  const handleDelete = async (integrationId) => {
    if (!window.confirm('Are you sure you want to delete this integration?')) {
      return;
    }
    
    try {
      setLoading(true);
      const token = localStorage.getItem('token');
      await axios.delete(`/api/integrations/${integrationId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      setSuccess('Integration deleted successfully!');
      fetchIntegrations();
    } catch (error) {
      console.error('Error deleting integration:', error);
      setError('Failed to delete integration');
    } finally {
      setLoading(false);
    }
  };

  // Test webhook
  const handleTestWebhook = async (webhookUrl) => {
    try {
      setLoading(true);
      const token = localStorage.getItem('token');
      const response = await axios.post('/api/discord/test-webhook', {
        webhookUrl
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      if (response.data.success) {
        setSuccess('Webhook test successful!');
      } else {
        setError('Webhook test failed');
      }
    } catch (error) {
      console.error('Error testing webhook:', error);
      setError('Failed to test webhook');
    } finally {
      setLoading(false);
    }
  };

  // Get status icon
  const getStatusIcon = (status) => {
    switch (status) {
      case 'connected':
        return <CheckCircleIcon color="success" />;
      case 'error':
        return <ErrorIcon color="error" />;
      case 'disconnected':
        return <ErrorIcon color="warning" />;
      default:
        return <CircularProgress size={20} />;
    }
  };

  return (
    <Box sx={{ p: 2 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant="h6" component="h2">
          Discord Integrations
        </Typography>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => setOpenDialog(true)}
          disabled={loading}
        >
          Add Discord Integration
        </Button>
      </Box>

      {/* Error/Success Messages */}
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}
      {success && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess('')}>
          {success}
        </Alert>
      )}

      {/* Integrations List */}
      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}>
          <CircularProgress />
        </Box>
      ) : integrations.length === 0 ? (
        <Paper sx={{ p: 3, textAlign: 'center' }}>
          <Typography color="textSecondary">
            No Discord integrations found. Click &quot;Add Discord Integration&quot; to get started.
          </Typography>
        </Paper>
      ) : (
        <List>
          {integrations.map((integration) => (
            <ListItem key={integration._id} sx={{ border: 1, borderColor: 'divider', mb: 1, borderRadius: 1 }}>
              <ListItemText
                primary={
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <LinkIcon color="primary" />
                    <Typography variant="subtitle1">
                      {integration.config?.serverName || 'Unknown Server'}
                    </Typography>
                    <Chip 
                      label={integration.status} 
                      size="small" 
                      color={integration.status === 'connected' ? 'success' : 'warning'}
                    />
                  </Box>
                }
                secondary={
                  <Typography variant="body2" color="textSecondary">
                    Channel: {integration.config?.channelName || 'Unknown Channel'}
                    {integration.lastSync && ` • Last sync: ${new Date(integration.lastSync).toLocaleString()}`}
                  </Typography>
                }
              />
              <ListItemSecondaryAction>
                <Box sx={{ display: 'flex', gap: 1 }}>
                  <IconButton
                    size="small"
                    onClick={() => handleTestWebhook(integration.config?.webhookUrl)}
                    disabled={loading}
                  >
                    <RefreshIcon />
                  </IconButton>
                  <IconButton
                    size="small"
                    color="error"
                    onClick={() => handleDelete(integration._id)}
                    disabled={loading}
                  >
                    <DeleteIcon />
                  </IconButton>
                </Box>
              </ListItemSecondaryAction>
            </ListItem>
          ))}
        </List>
      )}

      {/* Add Integration Dialog */}
      <Dialog open={openDialog} onClose={() => setOpenDialog(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Add Discord Integration</DialogTitle>
        <form onSubmit={handleSubmit}>
          <DialogContent>
            <Typography variant="body2" color="textSecondary" sx={{ mb: 2 }}>
              To integrate with Discord:
              <br />1. Add the Commonly bot to your Discord server
              <br />2. Select the channel for integration
              <br />3. Save the configuration
            </Typography>

            <Box sx={{ mb: 3, display: 'flex', alignItems: 'center', gap: 1 }}>
              <Button
                variant="contained"
                color="primary"
                startIcon={<LaunchIcon />}
                href={COMMONLY_BOT_INVITE_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                Add Bot to Server
              </Button>
              <Typography variant="caption" color="textSecondary">
                (Opens in new window)
              </Typography>
            </Box>
            
            <TextField
              fullWidth
              label="Server ID"
              name="serverId"
              value={formData.serverId}
              onChange={handleInputChange}
              required
              sx={{ mb: 2 }}
              helperText={
                <Typography variant="caption">
                  Enable Developer Mode in Discord (Settings → App Settings → Advanced) and right-click your server to copy ID
                </Typography>
              }
            />
            
            <TextField
              fullWidth
              label="Server Name"
              name="serverName"
              value={formData.serverName}
              onChange={handleInputChange}
              sx={{ mb: 2 }}
              helperText="Display name for the server"
            />
            
            <TextField
              fullWidth
              label="Channel ID"
              name="channelId"
              value={formData.channelId}
              onChange={handleInputChange}
              required
              sx={{ mb: 2 }}
              helperText={
                <Typography variant="caption">
                  Right-click the channel and select &quot;Copy ID&quot;
                </Typography>
              }
            />
            
            <TextField
              fullWidth
              label="Channel Name"
              name="channelName"
              value={formData.channelName}
              onChange={handleInputChange}
              sx={{ mb: 2 }}
              helperText="Display name for the channel"
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setOpenDialog(false)} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" variant="contained" disabled={loading}>
              {loading ? <CircularProgress size={20} /> : 'Create Integration'}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </Box>
  );
};

export default DiscordIntegration; 