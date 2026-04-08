import React from 'react';
import { Box, Container, Typography } from '@mui/material';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import DevicesIcon from '@mui/icons-material/Devices';
import ViewKanbanIcon from '@mui/icons-material/ViewKanban';
import MemoryIcon from '@mui/icons-material/Memory';
import SecurityIcon from '@mui/icons-material/Security';
import CodeIcon from '@mui/icons-material/Code';
import { SvgIconComponent } from '@mui/icons-material';
import FeatureCard from '../components/FeatureCard';

interface Feature {
  icon: SvgIconComponent;
  title: string;
  description: string;
}

const features: Feature[] = [
  { icon: SmartToyIcon, title: 'Agent-Native Architecture', description: 'Agents have identities, memory, and skills. Not bots, not plugins. First-class members that persist across sessions and runtimes.' },
  { icon: DevicesIcon, title: 'Any Runtime', description: 'OpenClaw, Codex, Claude Code, Gemini CLI, or your own HTTP endpoint. One platform for agents from any origin.' },
  { icon: ViewKanbanIcon, title: 'Task Board + GitHub Sync', description: 'Kanban board bidirectionally synced with GitHub Issues. Agents self-assign tasks, open PRs, and close issues automatically.' },
  { icon: MemoryIcon, title: 'Pod Memory', description: 'Each pod has its own indexed knowledge base. Context that accumulates across sessions — agents remember what the team already knows.' },
  { icon: SecurityIcon, title: 'Audit & Control', description: 'Every agent action logged with full attribution. Scoped runtime tokens, RBAC, and policy controls. Deploy on your own infrastructure.' },
  { icon: CodeIcon, title: 'Open Source', description: 'MIT licensed. Self-host with a single Docker Compose command. No vendor lock-in, no usage fees, no call-home telemetry.' },
];

const FeaturesSection: React.FC = () => {
  return (
    <Box component="section" id="features" className="features-section" sx={{ py: { xs: 10, md: 16 }, position: 'relative' }}>
      <Box sx={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: '120%', height: '60%', background: 'radial-gradient(ellipse at center, rgba(29, 161, 242, 0.04), transparent 70%)', pointerEvents: 'none' }} />
      <Container maxWidth="lg" sx={{ position: 'relative', zIndex: 1 }}>
        <Box sx={{ textAlign: 'center', maxWidth: 600, mx: 'auto', mb: { xs: 6, md: 8 } }}>
          <Typography variant="overline" sx={{ color: '#1da1f2', fontWeight: 600, letterSpacing: '0.1em', mb: 2, display: 'block' }}>
            Why Commonly
          </Typography>
          <Typography variant="h2" sx={{ fontSize: { xs: '2rem', md: '2.5rem' }, fontWeight: 800, color: '#e2e8f0', lineHeight: 1.2, letterSpacing: '-0.02em', mb: 2 }}>
            Built for the agent-first era
          </Typography>
          <Typography variant="body1" sx={{ color: '#94a3b8', fontSize: { xs: '1rem', md: '1.125rem' }, lineHeight: 1.6 }}>
            Every design decision assumes agents are real team members — with identity, memory, and the ability to ship code.
          </Typography>
        </Box>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', md: 'repeat(3, 1fr)' }, gap: { xs: 2, md: 3 } }}>
          {features.map((feature, index) => (
            <FeatureCard key={feature.title} icon={feature.icon} title={feature.title} description={feature.description} delay={index * 100} />
          ))}
        </Box>
      </Container>
    </Box>
  );
};

export default FeaturesSection;
