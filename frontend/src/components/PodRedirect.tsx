/* eslint-disable max-len */
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Typography, Button, CircularProgress, Container, Paper } from '@mui/material';
import ChatIcon from '@mui/icons-material/Chat';
import SchoolIcon from '@mui/icons-material/School';
import SportsEsportsIcon from '@mui/icons-material/SportsEsports';
import PsychologyIcon from '@mui/icons-material/Psychology';
import GroupsIcon from '@mui/icons-material/Groups';

const PodRedirect: React.FC = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setLoading(false);
    }, 500);
    return () => clearTimeout(timer);
  }, []);

  const handleNavigate = (podType: string): void => {
    navigate(`/pods/${podType}`);
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Container maxWidth="md" sx={{ mt: 8 }}>
      <Paper
        elevation={0}
        sx={{
          p: 4,
          borderRadius: 2,
          background: 'rgba(15, 23, 42, 0.92)',
          border: '1px solid rgba(148, 163, 184, 0.18)',
          boxShadow: '0 12px 30px rgba(8, 12, 24, 0.45)',
        }}
      >
        <Typography variant="h4" gutterBottom align="center">
          Choose a Pod Category
        </Typography>
        <Typography variant="body1" paragraph align="center" color="text.secondary">
          Select the type of pod you want to explore
        </Typography>

        <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, gap: 3, mt: 4, justifyContent: 'center', flexWrap: 'wrap' }}>
          <Button
            variant="contained"
            color="primary"
            size="large"
            startIcon={<ChatIcon />}
            onClick={() => handleNavigate('chat')}
            sx={{ py: 2, px: 4, borderRadius: 2, flex: 1 }}
          >
            Chat Pods
          </Button>

          <Button
            variant="contained"
            color="secondary"
            size="large"
            startIcon={<SchoolIcon />}
            onClick={() => handleNavigate('study')}
            sx={{ py: 2, px: 4, borderRadius: 2, flex: 1 }}
          >
            Study Pods
          </Button>

          <Button
            variant="contained"
            color="success"
            size="large"
            startIcon={<SportsEsportsIcon />}
            onClick={() => handleNavigate('games')}
            sx={{ py: 2, px: 4, borderRadius: 2, flex: 1 }}
          >
            Game Pods
          </Button>

          <Button
            variant="contained"
            color="info"
            size="large"
            startIcon={<PsychologyIcon />}
            onClick={() => handleNavigate('agent-ensemble')}
            sx={{ py: 2, px: 4, borderRadius: 2, flex: 1 }}
          >
            Agent Ensemble Pods
          </Button>

          <Button
            variant="contained"
            size="large"
            startIcon={<GroupsIcon />}
            onClick={() => handleNavigate('team')}
            sx={{ py: 2, px: 4, borderRadius: 2, flex: 1, backgroundColor: '#7c3aed', '&:hover': { backgroundColor: '#6d28d9' } }}
          >
            Team Pods
          </Button>
        </Box>
      </Paper>
    </Container>
  );
};

export default PodRedirect;
