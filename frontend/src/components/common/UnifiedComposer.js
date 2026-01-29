/**
 * UnifiedComposer Component
 *
 * Message composer that supports:
 * - @mentions for both humans and agents
 * - Quick agent actions (/commands)
 * - File attachments
 * - Emoji picker
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Box,
  TextField,
  IconButton,
  Button,
  Paper,
  List,
  ListItem,
  ListItemAvatar,
  ListItemText,
  Avatar,
  Typography,
  Chip,
  Popper,
  ClickAwayListener,
  Divider,
  alpha,
  useTheme,
} from '@mui/material';
import {
  Send as SendIcon,
  AttachFile as AttachIcon,
  EmojiEmotions as EmojiIcon,
  SmartToy as AgentIcon,
  Person as PersonIcon,
  Code as CodeIcon,
  Search as SearchIcon,
  Summarize as SummarizeIcon,
  CheckCircle as CheckIcon,
} from '@mui/icons-material';

// Quick actions (slash commands)
const quickActions = [
  {
    command: '/summarize',
    label: 'Summarize',
    description: 'Summarize recent discussion',
    icon: SummarizeIcon,
    agentRequired: true,
  },
  {
    command: '/search',
    label: 'Search',
    description: 'Search pod memory',
    icon: SearchIcon,
    agentRequired: true,
  },
  {
    command: '/review',
    label: 'Review',
    description: 'Request code review',
    icon: CodeIcon,
    agentRequired: true,
  },
  {
    command: '/task',
    label: 'Create Task',
    description: 'Create a task from message',
    icon: CheckIcon,
    agentRequired: false,
  },
];

const UnifiedComposer = ({
  onSend,
  onFileUpload,
  members = [],
  agents = [],
  placeholder = 'Type a message... or @mention',
  disabled = false,
  showFileUpload = true,
  showEmoji = true,
}) => {
  const theme = useTheme();
  const inputRef = useRef(null);
  const [message, setMessage] = useState('');
  const [mentionAnchor, setMentionAnchor] = useState(null);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionType, setMentionType] = useState(null); // 'mention' or 'command'
  const [selectedIndex, setSelectedIndex] = useState(0);

  // All mentionable participants (humans + agents)
  const allParticipants = [
    ...members.map((m) => ({ ...m, type: 'human' })),
    ...agents.map((a) => ({ ...a, type: 'agent', name: a.displayName || a.name })),
  ];

  // Filter participants by query
  const filteredParticipants = mentionQuery
    ? allParticipants.filter((p) =>
        (p.name || p.username || '').toLowerCase().includes(mentionQuery.toLowerCase())
      )
    : allParticipants;

  // Filter quick actions by query
  const filteredActions = mentionQuery
    ? quickActions.filter(
        (a) =>
          a.command.toLowerCase().includes(mentionQuery.toLowerCase()) ||
          a.label.toLowerCase().includes(mentionQuery.toLowerCase())
      )
    : quickActions;

  // Handle input change
  const handleChange = (e) => {
    const value = e.target.value;
    setMessage(value);

    // Check for @ mention trigger
    const atMatch = value.match(/@(\w*)$/);
    if (atMatch) {
      setMentionAnchor(inputRef.current);
      setMentionQuery(atMatch[1]);
      setMentionType('mention');
      setSelectedIndex(0);
      return;
    }

    // Check for / command trigger
    const slashMatch = value.match(/\/(\w*)$/);
    if (slashMatch && (value === slashMatch[0] || value.endsWith(' ' + slashMatch[0]))) {
      setMentionAnchor(inputRef.current);
      setMentionQuery(slashMatch[1]);
      setMentionType('command');
      setSelectedIndex(0);
      return;
    }

    // Close mention popup
    setMentionAnchor(null);
    setMentionType(null);
  };

  // Handle keyboard navigation
  const handleKeyDown = (e) => {
    if (mentionAnchor) {
      const items = mentionType === 'mention' ? filteredParticipants : filteredActions;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % items.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + items.length) % items.length);
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (items[selectedIndex]) {
          handleSelect(items[selectedIndex]);
        }
      } else if (e.key === 'Escape') {
        setMentionAnchor(null);
        setMentionType(null);
      }
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Handle mention/command selection
  const handleSelect = (item) => {
    if (mentionType === 'mention') {
      // Replace @query with @username
      const newMessage = message.replace(/@\w*$/, `@${item.username || item.name} `);
      setMessage(newMessage);
    } else if (mentionType === 'command') {
      // Replace /query with /command
      const newMessage = message.replace(/\/\w*$/, `${item.command} `);
      setMessage(newMessage);
    }

    setMentionAnchor(null);
    setMentionType(null);
    inputRef.current?.focus();
  };

  // Handle send
  const handleSend = () => {
    if (!message.trim() || disabled) return;

    // Extract mentions
    const mentionMatches = message.match(/@(\w+)/g) || [];
    const mentions = mentionMatches
      .map((m) => {
        const username = m.slice(1);
        return allParticipants.find(
          (p) => (p.username || p.name)?.toLowerCase() === username.toLowerCase()
        );
      })
      .filter(Boolean);

    // Check for commands
    const commandMatch = message.match(/^\/(\w+)/);
    const command = commandMatch ? quickActions.find((a) => a.command === `/${commandMatch[1]}`) : null;

    onSend({
      content: message,
      mentions,
      command: command ? { name: command.command, label: command.label } : null,
    });

    setMessage('');
  };

  return (
    <Box sx={{ position: 'relative' }}>
      {/* Main composer */}
      <Paper
        elevation={0}
        sx={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 1,
          p: 1.5,
          borderRadius: 3,
          border: `1px solid ${theme.palette.divider}`,
          backgroundColor: theme.palette.background.paper,
        }}
      >
        {/* Attachment button */}
        {showFileUpload && (
          <IconButton size="small" color="default" onClick={onFileUpload}>
            <AttachIcon />
          </IconButton>
        )}

        {/* Input field */}
        <TextField
          ref={inputRef}
          fullWidth
          multiline
          maxRows={5}
          placeholder={placeholder}
          value={message}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          variant="standard"
          InputProps={{
            disableUnderline: true,
            sx: { fontSize: '0.95rem' },
          }}
          sx={{ flex: 1 }}
        />

        {/* Emoji button */}
        {showEmoji && (
          <IconButton size="small" color="default">
            <EmojiIcon />
          </IconButton>
        )}

        {/* Send button */}
        <Button
          variant="contained"
          size="small"
          disabled={!message.trim() || disabled}
          onClick={handleSend}
          sx={{
            minWidth: 40,
            height: 36,
            borderRadius: 2,
          }}
        >
          <SendIcon fontSize="small" />
        </Button>
      </Paper>

      {/* Quick actions hint */}
      {agents.length > 0 && (
        <Box sx={{ display: 'flex', gap: 0.5, mt: 1, flexWrap: 'wrap' }}>
          <Typography variant="caption" color="text.secondary" sx={{ mr: 0.5 }}>
            Quick:
          </Typography>
          {quickActions.slice(0, 3).map((action) => (
            <Chip
              key={action.command}
              label={action.command}
              size="small"
              variant="outlined"
              onClick={() => setMessage(action.command + ' ')}
              sx={{
                height: 20,
                fontSize: '0.7rem',
                cursor: 'pointer',
                '&:hover': {
                  backgroundColor: alpha(theme.palette.primary.main, 0.08),
                },
              }}
            />
          ))}
        </Box>
      )}

      {/* Mention/Command popup */}
      <Popper
        open={Boolean(mentionAnchor)}
        anchorEl={mentionAnchor}
        placement="top-start"
        sx={{ zIndex: 1300 }}
      >
        <ClickAwayListener onClickAway={() => setMentionAnchor(null)}>
          <Paper
            elevation={8}
            sx={{
              width: 280,
              maxHeight: 300,
              overflow: 'auto',
              borderRadius: 2,
              mb: 1,
            }}
          >
            {mentionType === 'mention' && (
              <>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ px: 2, py: 1, display: 'block' }}
                >
                  Mention someone
                </Typography>
                <Divider />
                <List dense sx={{ py: 0 }}>
                  {filteredParticipants.length === 0 ? (
                    <ListItem>
                      <ListItemText
                        primary="No matches found"
                        primaryTypographyProps={{ color: 'text.secondary', fontSize: '0.875rem' }}
                      />
                    </ListItem>
                  ) : (
                    filteredParticipants.map((participant, index) => (
                      <ListItem
                        key={participant.id || participant.name}
                        button
                        selected={index === selectedIndex}
                        onClick={() => handleSelect(participant)}
                        sx={{
                          borderRadius: 1,
                          mx: 0.5,
                          my: 0.25,
                        }}
                      >
                        <ListItemAvatar sx={{ minWidth: 40 }}>
                          <Avatar
                            sx={{
                              width: 28,
                              height: 28,
                              fontSize: '0.875rem',
                              borderRadius: participant.type === 'agent' ? 1 : '50%',
                              backgroundColor:
                                participant.type === 'agent'
                                  ? alpha(theme.palette.primary.main, 0.1)
                                  : theme.palette.grey[300],
                              color:
                                participant.type === 'agent'
                                  ? theme.palette.primary.main
                                  : theme.palette.text.primary,
                            }}
                          >
                            {participant.type === 'agent' ? '🤖' : (participant.name || participant.username)?.charAt(0)}
                          </Avatar>
                        </ListItemAvatar>
                        <ListItemText
                          primary={participant.name || participant.username}
                          secondary={participant.type === 'agent' ? 'Agent' : 'Member'}
                          primaryTypographyProps={{ fontSize: '0.875rem', fontWeight: 500 }}
                          secondaryTypographyProps={{ fontSize: '0.75rem' }}
                        />
                        {participant.type === 'agent' && (
                          <Chip
                            label="AI"
                            size="small"
                            sx={{
                              height: 18,
                              fontSize: '0.625rem',
                              backgroundColor: alpha(theme.palette.primary.main, 0.1),
                              color: theme.palette.primary.main,
                            }}
                          />
                        )}
                      </ListItem>
                    ))
                  )}
                </List>
              </>
            )}

            {mentionType === 'command' && (
              <>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ px: 2, py: 1, display: 'block' }}
                >
                  Quick actions
                </Typography>
                <Divider />
                <List dense sx={{ py: 0 }}>
                  {filteredActions.length === 0 ? (
                    <ListItem>
                      <ListItemText
                        primary="No commands found"
                        primaryTypographyProps={{ color: 'text.secondary', fontSize: '0.875rem' }}
                      />
                    </ListItem>
                  ) : (
                    filteredActions.map((action, index) => (
                      <ListItem
                        key={action.command}
                        button
                        selected={index === selectedIndex}
                        onClick={() => handleSelect(action)}
                        sx={{
                          borderRadius: 1,
                          mx: 0.5,
                          my: 0.25,
                        }}
                      >
                        <ListItemAvatar sx={{ minWidth: 40 }}>
                          <Avatar
                            sx={{
                              width: 28,
                              height: 28,
                              backgroundColor: alpha(theme.palette.secondary.main, 0.1),
                              color: theme.palette.secondary.main,
                            }}
                          >
                            <action.icon sx={{ fontSize: 16 }} />
                          </Avatar>
                        </ListItemAvatar>
                        <ListItemText
                          primary={action.command}
                          secondary={action.description}
                          primaryTypographyProps={{
                            fontSize: '0.875rem',
                            fontWeight: 500,
                            fontFamily: 'monospace',
                          }}
                          secondaryTypographyProps={{ fontSize: '0.75rem' }}
                        />
                        {action.agentRequired && (
                          <Chip
                            icon={<AgentIcon sx={{ fontSize: 12 }} />}
                            label="Agent"
                            size="small"
                            sx={{
                              height: 18,
                              fontSize: '0.625rem',
                              '& .MuiChip-icon': { ml: 0.5 },
                            }}
                          />
                        )}
                      </ListItem>
                    ))
                  )}
                </List>
              </>
            )}
          </Paper>
        </ClickAwayListener>
      </Popper>
    </Box>
  );
};

export default UnifiedComposer;
