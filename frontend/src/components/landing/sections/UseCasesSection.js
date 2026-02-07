/**
 * UseCasesSection Component
 * Showcase section with rendered mock screenshots of the platform
 */

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Container, Typography, Tabs, Tab, alpha } from '@mui/material';
import ChatIcon from '@mui/icons-material/Chat';
import GroupsIcon from '@mui/icons-material/Groups';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import ArrowOutwardIcon from '@mui/icons-material/ArrowOutward';

const useCases = [
  {
    id: 'team-chat',
    label: 'Team Chat',
    icon: ChatIcon,
    title: 'Real-time conversations with persistent memory',
    description: 'Chat rooms where every message is searchable. Humans and AI agents collaborate side by side.',
    mockup: TeamChatMockup,
  },
  {
    id: 'agent-collab',
    label: 'Agent Collaboration',
    icon: SmartToyIcon,
    title: 'AI agents that work alongside your team',
    description: 'Agents join your pods, respond to mentions, and learn from team context to provide relevant help.',
    mockup: AgentCollabMockup,
  },
  {
    id: 'daily-digest',
    label: 'Daily Digest',
    icon: TrendingUpIcon,
    title: 'Never miss what matters',
    description: 'AI-powered summaries of all activity across your pods, integrations, and conversations.',
    mockup: DailyDigestMockup,
  },
  {
    id: 'community',
    label: 'Community Hub',
    icon: GroupsIcon,
    title: 'Bring all your communities together',
    description: 'Sync conversations from Discord, Slack, forums, and social media into one unified space.',
    mockup: CommunityHubMockup,
  },
];

// Mock UI Components for Screenshots

function TeamChatMockup() {
  return (
    <Box sx={{
      backgroundColor: 'rgba(15, 23, 42, 0.95)',
      borderRadius: '12px',
      overflow: 'hidden',
      border: '1px solid rgba(148, 163, 184, 0.15)',
      boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
    }}>
      {/* Window header */}
      <Box sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        p: 1.5,
        borderBottom: '1px solid rgba(148, 163, 184, 0.1)',
        backgroundColor: 'rgba(30, 41, 59, 0.5)',
      }}>
        <Box sx={{ display: 'flex', gap: 0.75 }}>
          <Box sx={{ width: 12, height: 12, borderRadius: '50%', backgroundColor: '#ef4444' }} />
          <Box sx={{ width: 12, height: 12, borderRadius: '50%', backgroundColor: '#f59e0b' }} />
          <Box sx={{ width: 12, height: 12, borderRadius: '50%', backgroundColor: '#22c55e' }} />
        </Box>
        <Typography variant="caption" sx={{ color: '#94a3b8', ml: 2 }}># product-team</Typography>
      </Box>

      {/* Chat messages */}
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
          name="@cuz"
          time="10:35 AM"
          color="#1da1f2"
          isAgent
          message="I found 3 related discussions about date pickers in your pod memory. The team decided on a 90-day default range last month. Want me to pull up the context?"
        />
        <ChatMessage
          avatar="S"
          name="Sarah"
          time="10:36 AM"
          color="#8b5cf6"
          message="@cuz yes please! That saves us a lot of time."
        />
      </Box>
    </Box>
  );
}

function AgentCollabMockup() {
  return (
    <Box sx={{
      backgroundColor: 'rgba(15, 23, 42, 0.95)',
      borderRadius: '12px',
      overflow: 'hidden',
      border: '1px solid rgba(148, 163, 184, 0.15)',
      boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
    }}>
      {/* Agent Hub header */}
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
          name="Cuz"
          role="Team Assistant"
          status="Active in 5 pods"
          color="#1da1f2"
          emoji="🤖"
        />
        <AgentCard
          name="Summarizer"
          role="Daily Digest"
          status="Last run: 2h ago"
          color="#22c55e"
          emoji="📊"
        />
        <AgentCard
          name="Code Review Bot"
          role="PR Assistant"
          status="Watching 3 repos"
          color="#f59e0b"
          emoji="🔍"
        />
        <AgentCard
          name="Community Manager"
          role="Discord Sync"
          status="Synced 142 messages"
          color="#8b5cf6"
          emoji="🌐"
        />
      </Box>
    </Box>
  );
}

function DailyDigestMockup() {
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
          Friday, Jan 31 • 47 activities across 6 pods
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
          title="Discord Community"
          highlight="New feature requests trending"
          stats="89 messages synced"
          color="#5865F2"
        />
        <DigestItem
          title="X/Twitter Mentions"
          highlight="3 positive reviews shared"
          stats="12 mentions tracked"
          color="#e2e8f0"
        />
      </Box>
    </Box>
  );
}

function CommunityHubMockup() {
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
          Connected Sources
        </Typography>
      </Box>

      <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <IntegrationRow icon="💬" name="Discord" detail="3 servers • 12 channels" color="#5865F2" />
        <IntegrationRow icon="📱" name="Slack" detail="2 workspaces • 8 channels" color="#4A154B" />
        <IntegrationRow icon="🐦" name="X (Twitter)" detail="@commonly • 2.4k followers" color="#1da1f2" />
        <IntegrationRow icon="📸" name="Instagram" detail="@commonly.ai • 892 followers" color="#E4405F" />
        <IntegrationRow icon="📝" name="Notion" detail="Team Wiki synced" color="#ffffff" />
        <IntegrationRow icon="🔗" name="Linear" detail="3 projects tracked" color="#5E6AD2" />
      </Box>
    </Box>
  );
}

// Helper Components

function ChatMessage({ avatar, name, time, message, color, isAgent }) {
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

function AgentCard({ name, role, status, color, emoji }) {
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

function DigestItem({ title, highlight, stats, color }) {
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

function IntegrationRow({ icon, name, detail, color }) {
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

const UseCasesSection = () => {
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
            Where humans and AI work together
          </Typography>
          <Typography
            variant="body1"
            sx={{
              color: '#94a3b8',
              fontSize: { xs: '1rem', md: '1.125rem' },
              lineHeight: 1.6,
            }}
          >
            From team chat to community management, Commonly brings everyone—and every agent—into the same space.
          </Typography>
        </Box>

        {/* Tabs */}
        <Box sx={{ display: 'flex', justifyContent: 'center', mb: 4 }}>
          <Tabs
            value={activeTab}
            onChange={(e, newValue) => setActiveTab(newValue)}
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
            {useCases.map((useCase, index) => (
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
      </Container>
    </Box>
  );
};

function getFeatureBullets(caseId) {
  const bullets = {
    'team-chat': [
      'Persistent message history that\'s fully searchable',
      'Agents respond to @mentions with relevant context',
      'Threads keep conversations organized',
    ],
    'agent-collab': [
      'Install agents from the marketplace or build your own',
      'Agents learn from pod memory over time',
      'Control which pods agents can access',
    ],
    'daily-digest': [
      'Personalized summaries based on your interests',
      'Key decisions and action items highlighted',
      'Cross-platform activity in one view',
    ],
    'community': [
      'Two-way sync with Discord, Slack, and more',
      'Track social mentions from X and Instagram',
      'Unified search across all connected platforms',
    ],
  };
  return bullets[caseId] || [];
}

export default UseCasesSection;
