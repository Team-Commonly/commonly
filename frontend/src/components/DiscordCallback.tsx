import React, { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Box,
  Button,
  Typography,
  Paper,
  Alert,
  CircularProgress,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Divider,
} from '@mui/material';
import { CheckCircle, Error, ArrowBack } from '@mui/icons-material';
import axios from 'axios';

interface Channel {
  id: string;
  name: string;
  topic?: string;
}

interface ServerInfo {
  id: string;
  name: string | null;
}

interface DiscordCallbackProps {
  type?: 'callback' | 'success' | 'error';
}

const DiscordCallback: React.FC<DiscordCallbackProps> = ({ type = 'callback' }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedChannel, setSelectedChannel] = useState('');
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);

  const urlParams = new URLSearchParams(location.search);
  const podId = urlParams.get('pod_id');
  const guildId = urlParams.get('guild_id');
  const serverName = urlParams.get('server_name');
  const errorMessage = urlParams.get('error');

  useEffect(() => {
    if (type === 'success' && guildId) {
      setServerInfo({ id: guildId, name: serverName });
      fetchChannels(guildId);
    } else if (type === 'error') {
      setError(errorMessage || 'Discord authorization failed');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, guildId, serverName, errorMessage]);

  const fetchChannels = async (id: string): Promise<void> => {
    try {
      setLoading(true);
      const token = localStorage.getItem('token');
      const response = await axios.get<Channel[]>(`/api/discord/channels/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setChannels(response.data);
    } catch (err) {
      console.error('Error fetching channels:', err);
      setError('Failed to fetch server channels');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateIntegration = async (): Promise<void> => {
    if (!selectedChannel || !podId || !guildId) {
      setError('Please select a channel');
      return;
    }

    try {
      setLoading(true);
      setError('');

      const selectedChannelInfo = channels.find((c) => c.id === selectedChannel);
      const token = localStorage.getItem('token');

      await axios.post(
        '/api/integrations',
        {
          podId,
          type: 'discord',
          config: {
            serverId: guildId,
            serverName: serverInfo?.name,
            channelId: selectedChannel,
            channelName: selectedChannelInfo?.name || 'Unknown Channel',
            webhookUrl: '',
            botToken: '',
            permissions: ['read_messages', 'send_messages', 'read_message_history'],
          },
        },
        { headers: { Authorization: `Bearer ${token}` } },
      );

      setSuccess('Discord integration created successfully!');

      try {
        const podResponse = await axios.get<{ type?: string }>(`/api/pods/${podId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const podType = podResponse.data.type || 'chat';
        setTimeout(() => navigate(`/pods/${podType}/${podId}`), 2000);
      } catch (podError) {
        console.error('Error fetching pod info, defaulting to chat:', podError);
        setTimeout(() => navigate(`/pods/chat/${podId}`), 2000);
      }
    } catch (err: unknown) {
      console.error('Error creating integration:', err);
      const e = err as { response?: { data?: { message?: string } } };
      setError(e.response?.data?.message || 'Failed to create integration');
    } finally {
      setLoading(false);
    }
  };

  if (type === 'error') {
    return (
      <Box sx={{ maxWidth: 600, mx: 'auto', mt: 4, p: 3 }}>
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <Error color="error" sx={{ fontSize: 64, mb: 2 }} />
          <Typography variant="h5" gutterBottom>
            Discord Authorization Failed
          </Typography>
          <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
            {errorMessage || 'Something went wrong during Discord authorization.'}
          </Typography>
          <Button variant="contained" startIcon={<ArrowBack />} onClick={() => navigate(-1)}>
            Go Back
          </Button>
        </Paper>
      </Box>
    );
  }

  if (type === 'success') {
    return (
      <Box sx={{ maxWidth: 600, mx: 'auto', mt: 4, p: 3 }}>
        <Paper sx={{ p: 4 }}>
          <Box sx={{ textAlign: 'center', mb: 4 }}>
            <CheckCircle color="success" sx={{ fontSize: 64, mb: 2 }} />
            <Typography variant="h5" gutterBottom>
              Discord Bot Added Successfully!
            </Typography>
            <Typography variant="body1" color="text.secondary">
              Server: <strong>{serverInfo?.name}</strong>
            </Typography>
          </Box>

          <Divider sx={{ mb: 4 }} />

          {error && <Alert severity="error" sx={{ mb: 3 }}>{error}</Alert>}
          {success && <Alert severity="success" sx={{ mb: 3 }}>{success}</Alert>}

          {!success && (
            <>
              <Typography variant="h6" gutterBottom>
                Select Channel for Integration
              </Typography>

              <FormControl fullWidth sx={{ mb: 3 }}>
                <InputLabel>Channel</InputLabel>
                <Select
                  value={selectedChannel}
                  onChange={(e) => setSelectedChannel(e.target.value)}
                  label="Channel"
                  disabled={loading}
                >
                  {channels.map((channel) => (
                    <MenuItem key={channel.id} value={channel.id}>
                      #{channel.name}
                      {channel.topic && (
                        <Typography variant="caption" sx={{ ml: 1, color: 'text.secondary' }}>
                          - {channel.topic}
                        </Typography>
                      )}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center' }}>
                <Button variant="outlined" onClick={() => navigate(-1)} disabled={loading}>
                  Cancel
                </Button>
                <Button
                  variant="contained"
                  onClick={handleCreateIntegration}
                  disabled={loading || !selectedChannel}
                >
                  {loading ? <CircularProgress size={20} /> : 'Create Integration'}
                </Button>
              </Box>
            </>
          )}
        </Paper>
      </Box>
    );
  }

  return (
    <Box sx={{ maxWidth: 600, mx: 'auto', mt: 4, p: 3 }}>
      <Paper sx={{ p: 4, textAlign: 'center' }}>
        <CircularProgress sx={{ mb: 2 }} />
        <Typography variant="h6">Processing Discord Authorization...</Typography>
        <Typography variant="body2" color="text.secondary">
          Please wait while we set up your Discord integration.
        </Typography>
      </Paper>
    </Box>
  );
};

export default DiscordCallback;
