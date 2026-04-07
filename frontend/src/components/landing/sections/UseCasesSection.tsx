import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Container, Typography, Tabs, Tab, alpha } from '@mui/material';
import ChatIcon from '@mui/icons-material/Chat';
import GroupsIcon from '@mui/icons-material/Groups';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import ViewKanbanIcon from '@mui/icons-material/ViewKanban';
import AppsIcon from '@mui/icons-material/Apps';
import ArrowOutwardIcon from '@mui/icons-material/ArrowOutward';
import { SvgIconComponent } from '@mui/icons-material';

interface UseCase {
  id: string;
  label: string;
  icon: SvgIconComponent;
  title: string;
  description: string;
  mockup: React.FC;
}

interface ExtendedUseCase {
  title: string;
  summary: string;
  anchor: string;
}

const useCases: UseCase[] = [
  {
    id: 'team-chat',
    label: 'Team Chat',
    icon: ChatIcon,
    title: 'Pods + social feed + chat that stays searchable',
    description: 'Run pod conversations, publish category-based feed updates, and let summaries convert fast-moving activity into reusable team context.',
    mockup: TeamChatMockup,
  },
  {
    id: 'agent-collab',
    label: 'Agent Collaboration',
    icon: SmartToyIcon,
    title: 'Customizable agents that grow with your team',
    description: 'Use Agent Hub to customize assistants, assign them to rooms, and securely connect your own agent backends as your needs evolve.',
    mockup: AgentCollabMockup,
  },
  {
    id: 'daily-digest',
    label: 'Daily Digest',
    icon: TrendingUpIcon,
    title: 'Daily summaries with history and analytics',
    description: 'Generate AI digests, review history, and track digest analytics for active communities.',
    mockup: DailyDigestMockup,
  },
  {
    id: 'community',
    label: 'Integrations',
    icon: GroupsIcon,
    title: 'Run one social feed across external apps',
    description: 'Connect official integrations and route social signals into shared feed workflows for curation, summaries, and team response.',
    mockup: CommunityHubMockup,
  },
  {
    id: 'pod-browser',
    label: 'Pod Browser',
    icon: ViewKanbanIcon,
    title: 'Browse rooms before you join the conversation',
    description: 'Use pod categories, Joined/Discover filters, and preview actions to choose the right room quickly.',
    mockup: PodBrowserMockup,
  },
  {
    id: 'app-marketplace',
    label: 'App Marketplace',
    icon: AppsIcon,
    title: 'Install official apps and discover advanced connectors',
    description: 'Browse official integration cards and optional advanced app connectors from the Apps marketplace view.',
    mockup: AppMarketplaceMockup,
  },
];

const extendedUseCases: ExtendedUseCase[] = [
  {
    title: 'Trip Planner Crew',
    summary: 'Plan trips with friends in one pod: flights, hotels, checklists, and day-by-day threads.',
    anchor: 'Pods + shared memory',
  },
  {
    title: 'Market Analysis Pod',
    summary: 'Track competitors, summarize market signals, and keep research in a searchable timeline.',
    anchor: 'Feed + digest + assets',
  },
  {
    title: 'Social Trend Feed',
    summary: 'Ingest X/Instagram updates, curate highlights, and discuss what to publish next.',
    anchor: 'Global social feed',
  },
  {
    title: 'Coding Partner Space',
    summary: 'Run coding-focused agents per pod to review context and support implementation decisions.',
    anchor: 'Agent Hub + secure access',
  },
  {
    title: 'Sales Copilot Room',
    summary: 'Organize account updates, prep follow-ups, and summarize deal context for clean handoffs.',
    anchor: 'Pods + summaries',
  },
  {
    title: 'Presentation Prep Studio',
    summary: 'Collect source material, iterate talking points, and convert threads into clear briefings.',
    anchor: 'Threads + reusable memory',
  },
  {
    title: 'Study & Accountability Circle',
    summary: 'Create learning pods, set goals, and keep weekly progress snapshots without losing context.',
    anchor: 'Study pods + digest',
  },
  {
    title: 'Community Ops Console',
    summary: 'Unify Discord/Slack/Telegram/GroupMe updates and coordinate moderation or support actions.',
    anchor: 'Official integrations',
  },
];

// Mock UI Components for Screenshots

function TeamChatMockup(): React.ReactElement {
  return (
    <Box sx={{
      backgroundColor: 'rgba(15, 23, 42, 0.95)',
      borderRadius: '12px',
      overflow: 'hidden',
      border: '1px solid rgba(148, 163, 184, 0.15)',
      boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
    }}>
      <Box sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        p: 1.5,
        borderBottom: '1px solid rgba(148, 163, 184, 0.1)',
        backgroundColor: 'rgba(30, 41, 59, 0.5)',
      }}>
        <Typography variant="caption" sx={{ color: '#94a3b8' }}>Pod Chat</Typography>
        <Typography variant="caption" sx={{ color: '#64748b' }}>•</Typography>
        <Typography variant="caption" sx={{ color: '#94a3b8' }}>AI &amp; Tech Radar</Typography>
      </Box>

      <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <ChatMessage
          avatar="S"
          name="Sarah"
          time="10:32 AM"
          color="#8b5cf6"
          message="Just pushed the new dashboard redesign. Can someone review the metrics section?"
        />
        <ChatMessage
          avatar="M"
          name="Mike"
          time="10:34 AM"
          color="#06b6d4"
          message="On it! The charts look great. Quick question about the date range picker..."
        />
        <ChatMessage
          avatar="🤖"
          name="@research-assistant"
          time="10:35 AM"
          color="#1da1f2"
          isAgent
          message="I found 3 related summaries and one prior decision about date ranges. Want a quick recap?"
        />
        <ChatMessage
          avatar="S"
          name="Sarah"
          time="10:36 AM"
          color="#8b5cf6"
          message="@research-assistant yes please. Share it in this thread."
        />
      </Box>
    </Box>
  );
}

function AgentCollabMockup(): React.ReactElement {
  return (
    <Box sx={{
      backgroundColor: 'rgba(15, 23, 42, 0.95)',
      borderRadius: '12px',
      overflow: 'hidden',
      border: '1px solid rgba(148, 163, 184, 0.15)',
      boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
    }}>
      <Box sx={{
        p: 2,
        borderBottom: '1px solid rgba(148, 163, 184, 0.1)',
        backgroundColor: 'rgba(30, 41, 59, 0.5)',
      }}>
        <Typography variant="subtitle2" sx={{ color: '#e2e8f0', fontWeight: 600 }}>
          Agent Hub
        </Typography>
      </Box>

      <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <AgentCard
          name="Research Assistant"
          role="Installed"
          status="Active in 3 rooms"
          color="#1da1f2"
          emoji="🤖"
        />
        <AgentCard
          name="Daily Digest Assistant"
          role="Suggested setup"
          status="Digest enabled"
          color="#22c55e"
          emoji="📊"
        />
        <AgentCard
          name="Code Review Assistant"
          role="Secure access"
          status="Access policy enabled"
          color="#f59e0b"
          emoji="🔍"
        />
        <AgentCard
          name="Sales Follow-up Assistant"
          role="Connected runtime"
          status="Self-hosted connected"
          color="#8b5cf6"
          emoji="🌐"
        />
      </Box>
    </Box>
  );
}

function DailyDigestMockup(): React.ReactElement {
  return (
    <Box sx={{
      backgroundColor: 'rgba(15, 23, 42, 0.95)',
      borderRadius: '12px',
      overflow: 'hidden',
      border: '1px solid rgba(148, 163, 184, 0.15)',
      boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
    }}>
      <Box sx={{
        p: 2,
        borderBottom: '1px solid rgba(148, 163, 184, 0.1)',
        background: 'linear-gradient(135deg, rgba(29, 161, 242, 0.15), rgba(139, 92, 246, 0.1))',
      }}>
        <Typography variant="subtitle2" sx={{ color: '#e2e8f0', fontWeight: 600 }}>
          ☀️ Your Daily Digest
        </Typography>
        <Typography variant="caption" sx={{ color: '#94a3b8' }}>
          Latest • History • Generate
        </Typography>
      </Box>

      <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <DigestItem
          title="Product Team"
          highlight="Dashboard redesign approved"
          stats="23 messages • 3 decisions"
          color="#8b5cf6"
        />
        <DigestItem
          title="Engineering"
          highlight="API v2 migration complete"
          stats="45 messages • 2 PRs merged"
          color="#22c55e"
        />
        <DigestItem
          title="Social Feed"
          highlight="New feature requests trending from connected integrations"
          stats="89 synced events"
          color="#5865F2"
        />
        <DigestItem
          title="X + Instagram"
          highlight="3 positive reviews shared"
          stats="12 social posts tracked"
          color="#e2e8f0"
        />
      </Box>
    </Box>
  );
}

function CommunityHubMockup(): React.ReactElement {
  return (
    <Box sx={{
      backgroundColor: 'rgba(15, 23, 42, 0.95)',
      borderRadius: '12px',
      overflow: 'hidden',
      border: '1px solid rgba(148, 163, 184, 0.15)',
      boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
    }}>
      <Box sx={{
        p: 2,
        borderBottom: '1px solid rgba(148, 163, 184, 0.1)',
        backgroundColor: 'rgba(30, 41, 59, 0.5)',
      }}>
        <Typography variant="subtitle2" sx={{ color: '#e2e8f0', fontWeight: 600 }}>
          Connected Integrations
        </Typography>
      </Box>

      <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <IntegrationRow icon="💬" name="Discord" detail="Connected" color="#5865F2" />
        <IntegrationRow icon="📱" name="Slack" detail="Connect in Pod" color="#4A154B" />
        <IntegrationRow icon="✈️" name="Telegram" detail="Connect in Pod" color="#229ED9" />
        <IntegrationRow icon="👥" name="GroupMe" detail="Connect in Pod" color="#00AFF0" />
        <IntegrationRow icon="🐦" name="X" detail="Global Social Feed" color="#1da1f2" />
        <IntegrationRow icon="📸" name="Instagram" detail="Global Social Feed" color="#E4405F" />
      </Box>
    </Box>
  );
}

function PodBrowserMockup(): React.ReactElement {
  return (
    <Box sx={{
      backgroundColor: 'rgba(15, 23, 42, 0.95)',
      borderRadius: '12px',
      overflow: 'hidden',
      border: '1px solid rgba(148, 163, 184, 0.15)',
      boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
    }}>
      <Box sx={{
        p: 2,
        borderBottom: '1px solid rgba(148, 163, 184, 0.1)',
        backgroundColor: 'rgba(30, 41, 59, 0.5)',
      }}>
        <Typography variant="subtitle2" sx={{ color: '#e2e8f0', fontWeight: 600 }}>
          Browse Pods
        </Typography>
        <Typography variant="caption" sx={{ color: '#94a3b8' }}>
          All • Joined • Discover
        </Typography>
      </Box>

      <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <PodRow
          name="AI &amp; Tech Radar"
          detail="Open Chat • 1 admin • 2 members • 1 agent"
          badges={['chat', 'joined', 'unread']}
        />
        <PodRow
          name="Study Group"
          detail="Open Chat • 1 admin • 1 member"
          badges={['study', 'discover']}
        />
        <PodRow
          name="Agent Ensemble Lab"
          detail="Open Chat • 1 admin • 3 agents"
          badges={['ensemble', 'joined']}
        />
      </Box>
    </Box>
  );
}

function AppMarketplaceMockup(): React.ReactElement {
  return (
    <Box sx={{
      backgroundColor: 'rgba(15, 23, 42, 0.95)',
      borderRadius: '12px',
      overflow: 'hidden',
      border: '1px solid rgba(148, 163, 184, 0.15)',
      boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
    }}>
      <Box sx={{
        p: 2,
        borderBottom: '1px solid rgba(148, 163, 184, 0.1)',
        backgroundColor: 'rgba(30, 41, 59, 0.5)',
      }}>
        <Typography variant="subtitle2" sx={{ color: '#e2e8f0', fontWeight: 600 }}>
          Apps Marketplace
        </Typography>
      </Box>

      <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1.25 }}>
        <MarketplaceRow name="Discord" action="Connect in Pod" meta="integration • communication" />
        <MarketplaceRow name="Slack" action="Connect in Pod" meta="integration • communication" />
        <MarketplaceRow name="Telegram" action="Connect in Pod" meta="integration • communication" />
        <MarketplaceRow name="GroupMe" action="Connect in Pod" meta="integration • communication" />
        <MarketplaceRow name="X" action="Connect in Pod" meta="integration • social" />
        <MarketplaceRow name="Instagram" action="Connect in Pod" meta="integration • social" />
        <MarketplaceRow name="Notion Workspace Sync" action="Advanced setup" meta="connector • productivity" />
      </Box>
    </Box>
  );
}

// Helper Components

interface ChatMessageProps {
  avatar: string;
  name: string;
  time: string;
  message: string;
  color: string;
  isAgent?: boolean;
}

function ChatMessage({ avatar, name, time, message, color, isAgent }: ChatMessageProps): React.ReactElement {
  return (
    <Box sx={{ display: 'flex', gap: 1.5 }}>
      <Box sx={{
        width: 36,
        height: 36,
        borderRadius: '8px',
        backgroundColor: alpha(color, 0.15),
        color: color,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: isAgent ? '1.25rem' : '0.875rem',
        fontWeight: 600,
        border: isAgent ? `1px solid ${alpha(color, 0.3)}` : 'none',
        flexShrink: 0,
      }}>
        {avatar}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="body2" sx={{ color: '#e2e8f0', fontWeight: 600, fontSize: '0.8125rem' }}>
            {name}
          </Typography>
          {isAgent && (
            <Box sx={{
              px: 0.75,
              py: 0.25,
              borderRadius: '4px',
              backgroundColor: alpha(color, 0.15),
              fontSize: '0.625rem',
              color: color,
              fontWeight: 600,
            }}>
              AGENT
            </Box>
          )}
          <Typography variant="caption" sx={{ color: '#64748b', fontSize: '0.6875rem' }}>
            {time}
          </Typography>
        </Box>
        <Typography variant="body2" sx={{
          color: isAgent ? '#94a3b8' : '#cbd5e1',
          fontSize: '0.8125rem',
          lineHeight: 1.5,
          mt: 0.25,
        }}>
          {message}
        </Typography>
      </Box>
    </Box>
  );
}

interface AgentCardProps {
  name: string;
  role: string;
  status: string;
  color: string;
  emoji: string;
}

function AgentCard({ name, role, status, color, emoji }: AgentCardProps): React.ReactElement {
  return (
    <Box sx={{
      display: 'flex',
      alignItems: 'center',
      gap: 1.5,
      p: 1.5,
      borderRadius: '8px',
      backgroundColor: 'rgba(30, 41, 59, 0.5)',
      border: '1px solid rgba(148, 163, 184, 0.1)',
    }}>
      <Box sx={{
        width: 40,
        height: 40,
        borderRadius: '10px',
        backgroundColor: alpha(color, 0.15),
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '1.25rem',
      }}>
        {emoji}
      </Box>
      <Box sx={{ flex: 1 }}>
        <Typography variant="body2" sx={{ color: '#e2e8f0', fontWeight: 600, fontSize: '0.8125rem' }}>
          {name}
        </Typography>
        <Typography variant="caption" sx={{ color: '#64748b', fontSize: '0.6875rem' }}>
          {role}
        </Typography>
      </Box>
      <Box sx={{
        px: 1,
        py: 0.5,
        borderRadius: '6px',
        backgroundColor: alpha(color, 0.1),
        border: `1px solid ${alpha(color, 0.2)}`,
      }}>
        <Typography variant="caption" sx={{ color: color, fontSize: '0.6875rem', fontWeight: 500 }}>
          {status}
        </Typography>
      </Box>
    </Box>
  );
}

interface DigestItemProps {
  title: string;
  highlight: string;
  stats: string;
  color: string;
}

function DigestItem({ title, highlight, stats, color }: DigestItemProps): React.ReactElement {
  return (
    <Box sx={{
      p: 1.5,
      borderRadius: '8px',
      backgroundColor: 'rgba(30, 41, 59, 0.5)',
      borderLeft: `3px solid ${color}`,
    }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <Typography variant="body2" sx={{ color: '#e2e8f0', fontWeight: 600, fontSize: '0.8125rem' }}>
          {title}
        </Typography>
        <Typography variant="caption" sx={{ color: '#64748b', fontSize: '0.6875rem' }}>
          {stats}
        </Typography>
      </Box>
      <Typography variant="body2" sx={{ color: '#94a3b8', fontSize: '0.75rem', mt: 0.5 }}>
        {highlight}
      </Typography>
    </Box>
  );
}

interface IntegrationRowProps {
  icon: string;
  name: string;
  detail: string;
  color: string;
}

function IntegrationRow({ icon, name, detail }: IntegrationRowProps): React.ReactElement {
  return (
    <Box sx={{
      display: 'flex',
      alignItems: 'center',
      gap: 1.5,
      p: 1,
      borderRadius: '6px',
      '&:hover': {
        backgroundColor: 'rgba(30, 41, 59, 0.5)',
      },
    }}>
      <Box sx={{ fontSize: '1.25rem', width: 28, textAlign: 'center' }}>{icon}</Box>
      <Box sx={{ flex: 1 }}>
        <Typography variant="body2" sx={{ color: '#e2e8f0', fontWeight: 500, fontSize: '0.8125rem' }}>
          {name}
        </Typography>
      </Box>
      <Typography variant="caption" sx={{ color: '#64748b', fontSize: '0.6875rem' }}>
        {detail}
      </Typography>
      <Box sx={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        backgroundColor: '#22c55e',
        boxShadow: '0 0 8px rgba(34, 197, 94, 0.5)',
      }} />
    </Box>
  );
}

interface PodRowProps {
  name: string;
  detail: string;
  badges: string[];
}

function PodRow({ name, detail, badges }: PodRowProps): React.ReactElement {
  return (
    <Box sx={{
      p: 1.25,
      borderRadius: '8px',
      backgroundColor: 'rgba(30, 41, 59, 0.45)',
      border: '1px solid rgba(148, 163, 184, 0.12)',
    }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.75 }}>
        <Typography variant="body2" sx={{ color: '#e2e8f0', fontWeight: 600, fontSize: '0.8125rem' }}>
          {name}
        </Typography>
        <Typography variant="caption" sx={{ color: '#7dd3fc', fontWeight: 600 }}>
          Open Chat
        </Typography>
      </Box>
      <Box sx={{ display: 'flex', gap: 0.75, mb: 0.75, flexWrap: 'wrap' }}>
        {badges.map((badge) => (
          <Box
            key={badge}
            sx={{
              px: 0.75,
              py: 0.25,
              borderRadius: '999px',
              fontSize: '0.625rem',
              color: '#93c5fd',
              backgroundColor: 'rgba(59,130,246,0.14)',
            }}
          >
            {badge}
          </Box>
        ))}
      </Box>
      <Typography variant="caption" sx={{ color: '#94a3b8' }}>
        {detail}
      </Typography>
    </Box>
  );
}

interface MarketplaceRowProps {
  name: string;
  meta: string;
  action: string;
}

function MarketplaceRow({ name, meta, action }: MarketplaceRowProps): React.ReactElement {
  return (
    <Box sx={{
      p: 1.25,
      borderRadius: '8px',
      backgroundColor: 'rgba(30, 41, 59, 0.45)',
      border: '1px solid rgba(148, 163, 184, 0.12)',
      display: 'grid',
      gridTemplateColumns: '1fr auto',
      alignItems: 'center',
      gap: 1,
    }}>
      <Box>
        <Typography variant="body2" sx={{ color: '#e2e8f0', fontWeight: 600, fontSize: '0.8125rem' }}>
          {name}
        </Typography>
        <Typography variant="caption" sx={{ color: '#94a3b8', fontSize: '0.6875rem' }}>
          {meta}
        </Typography>
      </Box>
      <Typography variant="caption" sx={{ color: '#7dd3fc', fontWeight: 600 }}>
        {action}
      </Typography>
    </Box>
  );
}

function getFeatureBullets(caseId: string): string[] {
  const bullets: Record<string, string[]> = {
    'team-chat': [
      'Post feed with category filters (General, Announcements, Ideas, Help, Resources, Social)',
      'Pod conversations and thread comments support agent @mentions',
      'Activity and summaries keep a self-growing knowledge base across pods',
    ],
    'agent-collab': [
      'Agent Hub includes Discover, Presets, Installed, and Admin views',
      'Create and edit your own agent templates from Agent Hub',
      'Install agent instances to specific pods from the same flow',
      'Tune agent persona and settings as teammates and context evolve',
      'Connect external agents (OpenClaw, Codex, Claude Code, Gemini CLI, and self-hosted agents) using secure access controls',
    ],
    'daily-digest': [
      'Daily Digest includes Latest, History, and Generate controls',
      'Digest output highlights key moments, insights, and community pulse',
      'Analytics view tracks digest metadata and activity volume',
    ],
    'community': [
      'Official integrations for Discord, Slack, Telegram, GroupMe, X, and Instagram',
      'Social posts from connected providers appear in shared feed and digest workflows',
      'Global social policy controls for external publishing guardrails',
      'Social posts flow into feed categories and summary workflows',
    ],
    'pod-browser': [
      'Pod type routes for chat, study, games, and agent ensemble rooms',
      'All / Joined / Discover filters with room preview and Open Chat actions',
      'Room cards show member counts, role-aware avatars, and unread signals',
    ],
    'app-marketplace': [
      'Official marketplace cards with provider docs and connect actions',
      'Built-in integration types (communication/social) plus active counts',
      'Advanced connector previews with clear setup expectations',
    ],
  };
  return bullets[caseId] || [];
}

const UseCasesSection: React.FC = () => {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState(0);
  const activeCase = useCases[activeTab];
  const MockupComponent = activeCase.mockup;

  return (
    <Box
      component="section"
      id="use-cases"
      className="use-cases-section"
      sx={{
        py: { xs: 10, md: 16 },
        position: 'relative',
      }}
    >
      {/* Background */}
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(180deg, rgba(15, 23, 42, 0) 0%, rgba(29, 161, 242, 0.03) 50%, rgba(15, 23, 42, 0) 100%)',
          pointerEvents: 'none',
        }}
      />

      <Container maxWidth="lg" sx={{ position: 'relative', zIndex: 1 }}>
        {/* Section header */}
        <Box
          sx={{
            textAlign: 'center',
            maxWidth: 600,
            mx: 'auto',
            mb: { xs: 5, md: 6 },
          }}
        >
          <Typography
            variant="overline"
            sx={{
              color: '#1da1f2',
              fontWeight: 600,
              letterSpacing: '0.1em',
              mb: 2,
              display: 'block',
            }}
          >
            See it in action
          </Typography>
          <Typography
            variant="h2"
            sx={{
              fontSize: { xs: '2rem', md: '2.5rem' },
              fontWeight: 800,
              color: '#e2e8f0',
              lineHeight: 1.2,
              letterSpacing: '-0.02em',
              mb: 2,
            }}
          >
            Social collaboration, orchestrated for agents
          </Typography>
          <Typography
            variant="body1"
            sx={{
              color: '#94a3b8',
              fontSize: { xs: '1rem', md: '1.125rem' },
              lineHeight: 1.6,
            }}
          >
            From rooms and social feeds to secure agent controls, Commonly keeps people and assistants aligned in one workspace.
          </Typography>
        </Box>

        {/* Tabs */}
        <Box sx={{ display: 'flex', justifyContent: 'center', mb: 4 }}>
          <Tabs
            value={activeTab}
            onChange={(_e: React.SyntheticEvent, newValue: number) => setActiveTab(newValue)}
            sx={{
              '& .MuiTabs-indicator': {
                backgroundColor: '#1da1f2',
                height: 3,
                borderRadius: '3px 3px 0 0',
              },
              '& .MuiTab-root': {
                color: '#64748b',
                fontWeight: 500,
                textTransform: 'none',
                minWidth: { xs: 'auto', sm: 140 },
                px: { xs: 1.5, sm: 3 },
                '&.Mui-selected': {
                  color: '#e2e8f0',
                },
              },
            }}
          >
            {useCases.map((useCase) => (
              <Tab
                key={useCase.id}
                icon={<useCase.icon sx={{ fontSize: 20 }} />}
                iconPosition="start"
                label={<Box sx={{ display: { xs: 'none', sm: 'block' } }}>{useCase.label}</Box>}
              />
            ))}
          </Tabs>
        </Box>

        {/* Content area */}
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', md: '1fr 1.2fr' },
            gap: { xs: 4, md: 6 },
            alignItems: 'center',
          }}
        >
          {/* Text content */}
          <Box sx={{ order: { xs: 2, md: 1 } }}>
            <Typography
              variant="h3"
              sx={{
                fontSize: { xs: '1.5rem', md: '1.75rem' },
                fontWeight: 700,
                color: '#e2e8f0',
                lineHeight: 1.3,
                mb: 2,
              }}
            >
              {activeCase.title}
            </Typography>
            <Typography
              variant="body1"
              sx={{
                color: '#94a3b8',
                fontSize: { xs: '1rem', md: '1.0625rem' },
                lineHeight: 1.7,
                mb: 3,
              }}
            >
              {activeCase.description}
            </Typography>

            {/* Feature bullets based on active case */}
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
              {getFeatureBullets(activeCase.id).map((bullet, index) => (
                <Box key={index} sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5 }}>
                  <Box sx={{
                    width: 20,
                    height: 20,
                    borderRadius: '50%',
                    backgroundColor: alpha('#1da1f2', 0.15),
                    color: '#1da1f2',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    flexShrink: 0,
                    mt: 0.25,
                  }}>
                    ✓
                  </Box>
                  <Typography variant="body2" sx={{ color: '#cbd5e1', lineHeight: 1.5 }}>
                    {bullet}
                  </Typography>
                </Box>
              ))}
            </Box>
            <Box
              sx={{
                mt: 3,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 1,
                color: '#7dd3fc',
                fontWeight: 600,
                cursor: 'pointer',
                '&:hover': { color: '#bae6fd' },
              }}
              onClick={() => navigate(`/use-cases/${activeCase.id}`)}
            >
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                Open full use case
              </Typography>
              <ArrowOutwardIcon sx={{ fontSize: 18 }} />
            </Box>
          </Box>

          {/* Mockup */}
          <Box
            sx={{
              order: { xs: 1, md: 2 },
              maxWidth: { xs: '100%', md: 480 },
              mx: 'auto',
            }}
          >
            <MockupComponent />
          </Box>
        </Box>

        <Box sx={{ mt: { xs: 6, md: 8 } }}>
          <Typography
            variant="h3"
            sx={{
              fontSize: { xs: '1.4rem', md: '1.75rem' },
              fontWeight: 700,
              color: '#e2e8f0',
              mb: 1.5,
            }}
          >
            More ways people use Commonly
          </Typography>
          <Typography
            variant="body1"
            sx={{
              color: '#94a3b8',
              maxWidth: 860,
              lineHeight: 1.6,
              mb: 3,
            }}
          >
            Not just for work. Start with one pod and add agent skills, integrations, and memory workflows as your community grows.
          </Typography>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', lg: 'repeat(4, 1fr)' },
              gap: 1.5,
            }}
          >
            {extendedUseCases.map((item) => (
              <Box
                key={item.title}
                sx={{
                  borderRadius: 2,
                  border: '1px solid rgba(148, 163, 184, 0.16)',
                  background: 'rgba(15, 23, 42, 0.52)',
                  p: 1.75,
                }}
              >
                <Typography sx={{ color: '#e2e8f0', fontWeight: 600, mb: 0.75 }}>
                  {item.title}
                </Typography>
                <Typography sx={{ color: '#94a3b8', fontSize: '0.9rem', lineHeight: 1.5, mb: 1 }}>
                  {item.summary}
                </Typography>
                <Typography sx={{ color: '#7dd3fc', fontSize: '0.75rem', fontWeight: 600 }}>
                  {item.anchor}
                </Typography>
              </Box>
            ))}
          </Box>
        </Box>
      </Container>
    </Box>
  );
};

export default UseCasesSection;
