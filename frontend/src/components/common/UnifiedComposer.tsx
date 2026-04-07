import React, { useState, useRef, useCallback } from 'react';
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
  Code as CodeIcon,
  Search as SearchIcon,
  Summarize as SummarizeIcon,
  CheckCircle as CheckIcon,
} from '@mui/icons-material';
import { SvgIconComponent } from '@mui/icons-material';

interface QuickAction {
  command: string;
  label: string;
  description: string;
  icon: SvgIconComponent;
  agentRequired: boolean;
}

const quickActions: QuickAction[] = [
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

interface Member {
  id?: string;
  username?: string;
  name?: string;
  [key: string]: unknown;
}

interface Agent {
  id?: string;
  name?: string;
  displayName?: string;
  [key: string]: unknown;
}

type Participant =
  | (Member & { type: 'human' })
  | (Agent & { type: 'agent'; name: string });

interface SendPayload {
  content: string;
  mentions: (Participant | undefined)[];
  command: { name: string; label: string } | null;
}

interface UnifiedComposerProps {
  onSend: (payload: SendPayload) => void;
  onFileUpload?: () => void;
  members?: Member[];
  agents?: Agent[];
  placeholder?: string;
  disabled?: boolean;
  showFileUpload?: boolean;
  showEmoji?: boolean;
}

const UnifiedComposer: React.FC<UnifiedComposerProps> = ({
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
  const inputRef = useRef<HTMLDivElement>(null);
  const [message, setMessage] = useState('');
  const [mentionAnchor, setMentionAnchor] = useState<HTMLDivElement | null>(null);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionType, setMentionType] = useState<'mention' | 'command' | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const allParticipants: Participant[] = [
    ...members.map((m): Participant => ({ ...m, type: 'human' as const })),
    ...agents.map((a): Participant => ({ ...a, type: 'agent' as const, name: a.displayName || a.name || '' })),
  ];

  const filteredParticipants = mentionQuery
    ? allParticipants.filter((p) =>
        ((p.name as string | undefined) || (p as Member).username || '').toLowerCase().includes(mentionQuery.toLowerCase())
      )
    : allParticipants;

  const filteredActions = mentionQuery
    ? quickActions.filter(
        (a) =>
          a.command.toLowerCase().includes(mentionQuery.toLowerCase()) ||
          a.label.toLowerCase().includes(mentionQuery.toLowerCase())
      )
    : quickActions;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const value = e.target.value;
    setMessage(value);

    const atMatch = value.match(/@(\w*)$/);
    if (atMatch) {
      setMentionAnchor(inputRef.current);
      setMentionQuery(atMatch[1]);
      setMentionType('mention');
      setSelectedIndex(0);
      return;
    }

    const slashMatch = value.match(/\/(\w*)$/);
    if (slashMatch && (value === slashMatch[0] || value.endsWith(' ' + slashMatch[0]))) {
      setMentionAnchor(inputRef.current);
      setMentionQuery(slashMatch[1]);
      setMentionType('command');
      setSelectedIndex(0);
      return;
    }

    setMentionAnchor(null);
    setMentionType(null);
  };

  const handleSelect = useCallback((item: Participant | QuickAction): void => {
    if (mentionType === 'mention') {
      const p = item as Participant;
      const name = (p as Member).username || p.name;
      const newMessage = message.replace(/@\w*$/, `@${name} `);
      setMessage(newMessage);
    } else if (mentionType === 'command') {
      const action = item as QuickAction;
      const newMessage = message.replace(/\/\w*$/, `${action.command} `);
      setMessage(newMessage);
    }

    setMentionAnchor(null);
    setMentionType(null);
    (inputRef.current?.querySelector('textarea') as HTMLTextAreaElement | null)?.focus();
  }, [mentionType, message]);

  const handleSend = useCallback((): void => {
    if (!message.trim() || disabled) return;

    const mentionMatches = message.match(/@(\w+)/g) || [];
    const mentions = mentionMatches
      .map((m) => {
        const username = m.slice(1);
        return allParticipants.find(
          (p) => ((p as Member).username || p.name)?.toLowerCase() === username.toLowerCase()
        );
      })
      .filter(Boolean);

    const commandMatch = message.match(/^\/(\w+)/);
    const command = commandMatch ? quickActions.find((a) => a.command === `/${commandMatch[1]}`) : null;

    onSend({
      content: message,
      mentions,
      command: command ? { name: command.command, label: command.label } : null,
    });

    setMessage('');
  }, [message, disabled, allParticipants, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (mentionAnchor) {
      const items: (Participant | QuickAction)[] =
        mentionType === 'mention' ? filteredParticipants : filteredActions;

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
        {showFileUpload && (
          <IconButton size="small" color="default" onClick={onFileUpload}>
            <AttachIcon />
          </IconButton>
        )}

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

        {showEmoji && (
          <IconButton size="small" color="default">
            <EmojiIcon />
          </IconButton>
        )}

        <Button
          variant="contained"
          size="small"
          disabled={!message.trim() || disabled}
          onClick={handleSend}
          sx={{ minWidth: 40, height: 36, borderRadius: 2 }}
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
            sx={{ width: 280, maxHeight: 300, overflow: 'auto', borderRadius: 2, mb: 1 }}
          >
            {mentionType === 'mention' && (
              <>
                <Typography variant="caption" color="text.secondary" sx={{ px: 2, py: 1, display: 'block' }}>
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
                        key={(participant as Member).id || participant.name}
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        {...{ button: true } as any}
                        selected={index === selectedIndex}
                        onClick={() => handleSelect(participant)}
                        sx={{ borderRadius: 1, mx: 0.5, my: 0.25 }}
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
                            {participant.type === 'agent'
                              ? '🤖'
                              : (participant.name || (participant as Member).username)?.charAt(0)}
                          </Avatar>
                        </ListItemAvatar>
                        <ListItemText
                          primary={participant.name || (participant as Member).username}
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
                <Typography variant="caption" color="text.secondary" sx={{ px: 2, py: 1, display: 'block' }}>
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
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        {...{ button: true } as any}
                        selected={index === selectedIndex}
                        onClick={() => handleSelect(action)}
                        sx={{ borderRadius: 1, mx: 0.5, my: 0.25 }}
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
                          primaryTypographyProps={{ fontSize: '0.875rem', fontWeight: 500, fontFamily: 'monospace' }}
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
