import React, { useState } from 'react';
import {
  Box,
  Typography,
  Button,
  TextField,
  IconButton,
  Tooltip,
  Chip,
  Paper,
  Divider,
  Collapse,
  Alert,
  FormGroup,
  FormControlLabel,
  Checkbox,
} from '@mui/material';
import {
  ContentCopy as CopyIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  CheckCircle as ConnectedIcon,
  Cancel as DisconnectedIcon,
  Refresh as RefreshIcon,
} from '@mui/icons-material';
import { alpha, useTheme } from '@mui/material/styles';

/**
 * ClawdbotConfigPanel - Configuration panel for Clawdbot integration
 *
 * Shows:
 * 1. Commonly-hosted Clawdbot status
 * 2. "Connect your own Clawdbot" with token + config snippet
 * 3. Channel status (future)
 */
const ClawdbotConfigPanel = ({
  runtimeTokens = [],
  runtimeTokenValue,
  onGenerateToken,
  onRevokeToken,
  tokenLoading,
  gatewayStatus,
  onRefreshStatus,
  userTokenValue,
  userTokenMeta,
  userTokenScopes = [],
  userTokenLoading,
  userTokenRevoking,
  onToggleUserScope,
  onGenerateUserToken,
  onRevokeUserToken,
}) => {
  const theme = useTheme();
  const [copied, setCopied] = useState(false);
  const [configCopied, setConfigCopied] = useState(false);
  const [showConfigSnippet, setShowConfigSnippet] = useState(false);

  const copyToClipboard = async (text, setCopiedFn) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedFn(true);
      setTimeout(() => setCopiedFn(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const generateConfigSnippet = (runtimeToken, userToken) => {
    return `{
  "channels": {
    "commonly": {
      "enabled": true,
      "baseUrl": "${window.location.origin}",
      "runtimeToken": "${runtimeToken || '<runtime-token>'}",
      "userToken": "${userToken || '<user-token>'}",
      "agentName": "openclaw",
      "instanceId": "default"
    }
  }
}`;
  };

  const activeToken = runtimeTokenValue || (runtimeTokens.length > 0 ? '••••••••' : null);
  const hasUserToken = userTokenMeta?.hasToken;

  return (
    <Box sx={{ mt: 2 }}>
      {/* Section Header */}
      <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600 }}>
        Clawdbot Integration
      </Typography>

      {/* Commonly-hosted Clawdbot Status */}
      <Paper
        variant="outlined"
        sx={{
          p: 2,
          mb: 2,
          borderColor: alpha(theme.palette.primary.main, 0.2),
          bgcolor: alpha(theme.palette.primary.main, 0.02),
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
          <Typography variant="body2" fontWeight={500}>
            Commonly-hosted Clawdbot
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {gatewayStatus?.connected ? (
              <Chip
                icon={<ConnectedIcon sx={{ fontSize: 16 }} />}
                label="Connected"
                size="small"
                color="success"
                variant="outlined"
              />
            ) : (
              <Chip
                icon={<DisconnectedIcon sx={{ fontSize: 16 }} />}
                label="Not configured"
                size="small"
                color="default"
                variant="outlined"
              />
            )}
            <Tooltip title="Refresh status">
              <IconButton size="small" onClick={onRefreshStatus}>
                <RefreshIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>
        <Typography variant="caption" color="text.secondary">
          Shared AI assistant powered by Clawdbot. Responds to events in this pod.
        </Typography>

        {gatewayStatus?.channels && gatewayStatus.channels.length > 0 && (
          <Box sx={{ mt: 1.5, display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
            {gatewayStatus.channels.map((channel) => (
              <Chip
                key={channel}
                label={channel}
                size="small"
                variant="outlined"
                sx={{ fontSize: '0.7rem' }}
              />
            ))}
          </Box>
        )}
      </Paper>

      <Divider sx={{ my: 2 }} />

      {/* Connect Your Own Clawdbot */}
      <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
        Connect Your Own Clawdbot
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
        Run Clawdbot on your machine with your personal channels (Gmail, Discord, etc.)
        and connect it to this pod.
      </Typography>

      {/* Runtime Token Section */}
      {activeToken ? (
        <Box sx={{ mb: 2 }}>
          <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5, display: 'block' }}>
            Your Runtime Token
          </Typography>
          <Box
            sx={{
              border: `1px solid ${alpha(theme.palette.success.main, 0.3)}`,
              borderRadius: 1,
              p: 1.5,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              bgcolor: alpha(theme.palette.success.main, 0.05),
            }}
          >
            <Typography
              variant="body2"
              sx={{
                fontFamily: 'monospace',
                fontSize: '0.8rem',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {runtimeTokenValue || '••••••••••••••••••••'}
            </Typography>
            {runtimeTokenValue && (
              <Tooltip title={copied ? 'Copied!' : 'Copy token'}>
                <IconButton
                  size="small"
                  onClick={() => copyToClipboard(runtimeTokenValue, setCopied)}
                >
                  <CopyIcon fontSize="small" color={copied ? 'success' : 'inherit'} />
                </IconButton>
              </Tooltip>
            )}
          </Box>

          {runtimeTokenValue && (
            <Alert severity="info" sx={{ mt: 1, py: 0.5 }}>
              <Typography variant="caption">
                Save this token now - it will not be shown again.
              </Typography>
            </Alert>
          )}
        </Box>
      ) : (
        <Button
          variant="outlined"
          size="small"
          onClick={onGenerateToken}
          disabled={tokenLoading}
          sx={{ mb: 2 }}
        >
          {tokenLoading ? 'Generating...' : 'Generate Runtime Token'}
        </Button>
      )}

      {/* Config Snippet */}
      <Box>
        <Button
          size="small"
          onClick={() => setShowConfigSnippet(!showConfigSnippet)}
          endIcon={showConfigSnippet ? <ExpandLessIcon /> : <ExpandMoreIcon />}
          sx={{ mb: 1, textTransform: 'none' }}
        >
          {showConfigSnippet ? 'Hide' : 'Show'} moltbot.json config
        </Button>

        <Collapse in={showConfigSnippet}>
          <Box sx={{ position: 'relative' }}>
            <TextField
              multiline
              fullWidth
              rows={12}
              value={generateConfigSnippet(runtimeTokenValue, userTokenValue)}
              InputProps={{
                readOnly: true,
                sx: {
                  fontFamily: 'monospace',
                  fontSize: '0.75rem',
                  bgcolor: alpha(theme.palette.grey[500], 0.05),
                },
              }}
              size="small"
            />
            <Tooltip title={configCopied ? 'Copied!' : 'Copy config'}>
              <IconButton
                size="small"
                onClick={() =>
                  copyToClipboard(
                    generateConfigSnippet(runtimeTokenValue, userTokenValue),
                    setConfigCopied,
                  )
                }
                sx={{ position: 'absolute', top: 8, right: 8 }}
              >
                <CopyIcon fontSize="small" color={configCopied ? 'success' : 'inherit'} />
              </IconButton>
            </Tooltip>
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            Add this to your <code>~/.clawdbot/moltbot.json</code> to connect your Clawdbot to Commonly.
            Runtime token is required; user token is optional for tools/context access.
          </Typography>
        </Collapse>
      </Box>

      {/* Existing Tokens */}
      {runtimeTokens.length > 0 && (
        <Box sx={{ mt: 2 }}>
          <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: 'block' }}>
            Active Connections ({runtimeTokens.length})
          </Typography>
          {runtimeTokens.map((token) => (
            <Box
              key={token.id}
              sx={{
                border: `1px solid ${alpha(theme.palette.divider, 0.5)}`,
                borderRadius: 1,
                p: 1,
                mb: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <Box>
                <Typography variant="body2" fontWeight={500}>
                  {token.label || 'Unnamed'}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Created {new Date(token.createdAt).toLocaleDateString()}
                  {token.lastUsedAt && ` • Last used ${new Date(token.lastUsedAt).toLocaleDateString()}`}
                </Typography>
              </Box>
              <Button
                size="small"
                color="error"
                onClick={() => onRevokeToken(token.id)}
              >
                Revoke
              </Button>
            </Box>
          ))}
        </Box>
      )}

      <Divider sx={{ my: 2 }} />

      <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
        Designated User Token
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
        Issue a bot user token with optional permissions. Leave all permissions unchecked for full access.
        Generating a new token rotates the old one.
      </Typography>

      <FormGroup sx={{ mb: 2 }}>
        {[
          { id: 'agent:events:read', label: 'Read agent events' },
          { id: 'agent:events:ack', label: 'Acknowledge agent events' },
          { id: 'agent:context:read', label: 'Read pod context' },
          { id: 'agent:messages:read', label: 'Read pod messages' },
          { id: 'agent:messages:write', label: 'Post pod messages' },
        ].map((scope) => (
          <FormControlLabel
            key={scope.id}
            control={(
              <Checkbox
                checked={userTokenScopes.includes(scope.id)}
                onChange={() => onToggleUserScope?.(scope.id)}
                size="small"
              />
            )}
            label={<Typography variant="caption">{scope.label}</Typography>}
          />
        ))}
      </FormGroup>

      {hasUserToken && (
        <Alert severity="info" sx={{ mb: 2 }}>
          <Typography variant="caption">
            Token issued {userTokenMeta?.createdAt ? new Date(userTokenMeta.createdAt).toLocaleString() : 'recently'}.
            Revoke to rotate.
          </Typography>
        </Alert>
      )}

      <Button
        variant="outlined"
        size="small"
        onClick={onGenerateUserToken}
        disabled={userTokenLoading}
        sx={{ mb: 2 }}
      >
        {userTokenLoading ? 'Generating...' : 'Generate User Token'}
      </Button>

      {userTokenValue && (
        <Box sx={{ mb: 2 }}>
          <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5, display: 'block' }}>
            User Token (shown once)
          </Typography>
          <Box
            sx={{
              border: `1px solid ${alpha(theme.palette.success.main, 0.3)}`,
              borderRadius: 1,
              p: 1.5,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              bgcolor: alpha(theme.palette.success.main, 0.05),
            }}
          >
            <Typography
              variant="body2"
              sx={{
                fontFamily: 'monospace',
                fontSize: '0.8rem',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {userTokenValue}
            </Typography>
            <Tooltip title={copied ? 'Copied!' : 'Copy token'}>
              <IconButton
                size="small"
                onClick={() => copyToClipboard(userTokenValue, setCopied)}
              >
                <CopyIcon fontSize="small" color={copied ? 'success' : 'inherit'} />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>
      )}

      <Button
        size="small"
        color="error"
        onClick={onRevokeUserToken}
        disabled={!hasUserToken || userTokenRevoking}
      >
        {userTokenRevoking ? 'Revoking...' : 'Revoke User Token'}
      </Button>
    </Box>
  );
};

export default ClawdbotConfigPanel;
