/**
 * PodHeader Component
 *
 * Header for a pod showing members (humans + agents), stats, and actions.
 * Key element of the hybrid social experience.
 */

import React, { useState } from 'react';
import {
  Box,
  Typography,
  Avatar,
  AvatarGroup,
  Button,
  IconButton,
  Chip,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  Tooltip,
  alpha,
  useTheme,
} from '@mui/material';
import {
  Settings as SettingsIcon,
  Add as AddIcon,
  SmartToy as AgentIcon,
  Person as PersonIcon,
  MoreVert as MoreIcon,
  Link as LinkIcon,
  Memory as MemoryIcon,
  AutoAwesome as SkillIcon,
  Article as SummaryIcon,
  Share as ShareIcon,
  Notifications as NotificationsIcon,
  NotificationsOff as MuteIcon,
} from '@mui/icons-material';

interface PodData {
  name: string;
  description?: string;
  type: string;
  icon?: string;
}

interface PodMember {
  id: string;
  name?: string;
  type?: string;
  online?: boolean;
  color?: string;
}

interface PodAgent {
  id: string;
  name?: string;
  status?: string;
}

interface PodStats {
  memoryCount?: number;
  skillCount?: number;
  summaryCount?: number;
  linkedPods?: number;
}

interface PodHeaderProps {
  pod: PodData;
  members?: PodMember[];
  agents?: PodAgent[];
  stats?: PodStats;
  onAddAgent?: () => void;
  onInviteMember?: () => void;
  onSettings?: () => void;
  onLinkPod?: () => void;
}

interface StatItemProps {
  icon: React.ReactNode;
  label: string;
  value: number;
  unit?: string;
  action?: React.ReactNode;
}

const PodHeader: React.FC<PodHeaderProps> = ({
  pod,
  members = [],
  agents = [],
  stats = {},
  onAddAgent,
  onInviteMember,
  onSettings,
  onLinkPod,
}) => {
  const theme = useTheme();
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);

  const {
    name,
    description,
    type,
    icon = '📦',
  } = pod;

  const humanMembers = members.filter((m) => m.type === 'human');
  const onlineHumans = humanMembers.filter((m) => m.online);
  const activeAgents = agents.filter((a) => a.status === 'active');

  return (
    <Box
      sx={{
        background: `linear-gradient(135deg, ${alpha(theme.palette.primary.main, 0.08)} 0%, ${alpha(theme.palette.primary.main, 0.02)} 100%)`,
        borderRadius: 4,
        p: 3,
        mb: 3,
      }}
    >
      {/* Top row: Icon, Name, Actions */}
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2, mb: 2 }}>
        {/* Pod icon */}
        <Avatar
          sx={{
            width: 64,
            height: 64,
            fontSize: '2rem',
            backgroundColor: theme.palette.background.paper,
            border: `2px solid ${theme.palette.divider}`,
            borderRadius: 3,
          }}
        >
          {icon}
        </Avatar>

        {/* Name and description */}
        <Box sx={{ flex: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
            <Typography variant="h5" fontWeight={700}>
              {name}
            </Typography>
            <Chip
              label={type}
              size="small"
              sx={{
                height: 22,
                fontSize: '0.75rem',
                fontWeight: 500,
              }}
            />
          </Box>
          <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 600 }}>
            {description}
          </Typography>
        </Box>

        {/* Actions */}
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Tooltip title="Notifications">
            <IconButton>
              <NotificationsIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title="Settings">
            <IconButton onClick={onSettings}>
              <SettingsIcon />
            </IconButton>
          </Tooltip>
          <IconButton onClick={(e) => setMoreAnchor(e.currentTarget)}>
            <MoreIcon />
          </IconButton>
        </Box>
      </Box>

      {/* Members row */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 3,
          py: 2,
          borderTop: `1px solid ${alpha(theme.palette.divider, 0.5)}`,
          borderBottom: `1px solid ${alpha(theme.palette.divider, 0.5)}`,
        }}
      >
        {/* Humans */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <PersonIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
            <Typography variant="body2" color="text.secondary">
              {humanMembers.length} members
            </Typography>
            {onlineHumans.length > 0 && (
              <Chip
                label={`${onlineHumans.length} online`}
                size="small"
                sx={{
                  height: 18,
                  fontSize: '0.625rem',
                  backgroundColor: alpha(theme.palette.success.main, 0.1),
                  color: theme.palette.success.main,
                }}
              />
            )}
          </Box>
          <AvatarGroup
            max={5}
            sx={{
              '& .MuiAvatar-root': {
                width: 32,
                height: 32,
                fontSize: '0.875rem',
                border: `2px solid ${theme.palette.background.paper}`,
              },
            }}
          >
            {humanMembers.slice(0, 5).map((member) => (
              <Tooltip key={member.id} title={member.name ?? ''}>
                <Avatar sx={{ backgroundColor: member.color || theme.palette.grey[400] }}>
                  {member.name?.charAt(0)}
                </Avatar>
              </Tooltip>
            ))}
          </AvatarGroup>
          <Button
            size="small"
            startIcon={<AddIcon />}
            onClick={onInviteMember}
            sx={{ ml: 1 }}
          >
            Invite
          </Button>
        </Box>

        <Box sx={{ width: 1, height: 32, backgroundColor: 'divider' }} />

        {/* Agents */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <AgentIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
            <Typography variant="body2" color="text.secondary">
              {agents.length} agents
            </Typography>
            {activeAgents.length > 0 && (
              <Chip
                label={`${activeAgents.length} active`}
                size="small"
                sx={{
                  height: 18,
                  fontSize: '0.625rem',
                  backgroundColor: alpha(theme.palette.primary.main, 0.1),
                  color: theme.palette.primary.main,
                }}
              />
            )}
          </Box>
          <AvatarGroup
            max={4}
            sx={{
              '& .MuiAvatar-root': {
                width: 32,
                height: 32,
                fontSize: '1rem',
                borderRadius: 1.5,
                border: `2px solid ${theme.palette.background.paper}`,
                backgroundColor: alpha(theme.palette.primary.main, 0.1),
                color: theme.palette.primary.main,
              },
            }}
          >
            {agents.slice(0, 4).map((agent) => (
              <Tooltip key={agent.id} title={agent.name ?? ''}>
                <Avatar>🤖</Avatar>
              </Tooltip>
            ))}
          </AvatarGroup>
          <Button
            size="small"
            variant="outlined"
            startIcon={<AddIcon />}
            onClick={onAddAgent}
            sx={{ ml: 1 }}
          >
            Add Agent
          </Button>
        </Box>
      </Box>

      {/* Stats row */}
      <Box
        sx={{
          display: 'flex',
          gap: 4,
          pt: 2,
        }}
      >
        <StatItem
          icon={<MemoryIcon sx={{ fontSize: 18 }} />}
          label="Memory"
          value={stats.memoryCount || 0}
          unit="entries"
        />
        <StatItem
          icon={<SkillIcon sx={{ fontSize: 18 }} />}
          label="Skills"
          value={stats.skillCount || 0}
          unit=""
        />
        <StatItem
          icon={<SummaryIcon sx={{ fontSize: 18 }} />}
          label="Summaries"
          value={stats.summaryCount || 0}
          unit="this week"
        />
        <StatItem
          icon={<LinkIcon sx={{ fontSize: 18 }} />}
          label="Linked Pods"
          value={stats.linkedPods || 0}
          unit=""
          action={
            <Button size="small" variant="text" onClick={onLinkPod}>
              + Link
            </Button>
          }
        />
      </Box>

      {/* More menu */}
      <Menu
        anchorEl={moreAnchor}
        open={Boolean(moreAnchor)}
        onClose={() => setMoreAnchor(null)}
      >
        <MenuItem onClick={() => { setMoreAnchor(null); onLinkPod?.(); }}>
          <ListItemIcon>
            <LinkIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Link to another pod</ListItemText>
        </MenuItem>
        <MenuItem>
          <ListItemIcon>
            <ShareIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Share pod</ListItemText>
        </MenuItem>
        <MenuItem>
          <ListItemIcon>
            <MuteIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Mute notifications</ListItemText>
        </MenuItem>
      </Menu>
    </Box>
  );
};

// Stat item component
const StatItem: React.FC<StatItemProps> = ({ icon, label, value, unit, action }) => {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      <Box sx={{ color: 'text.secondary' }}>{icon}</Box>
      <Box>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5 }}>
          <Typography variant="h6" fontWeight={700}>
            {value.toLocaleString()}
          </Typography>
          {unit && (
            <Typography variant="caption" color="text.secondary">
              {unit}
            </Typography>
          )}
        </Box>
        <Typography variant="caption" color="text.secondary">
          {label}
        </Typography>
      </Box>
      {action}
    </Box>
  );
};

export default PodHeader;
