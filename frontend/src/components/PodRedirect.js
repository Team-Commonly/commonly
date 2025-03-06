import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Typography, Button, CircularProgress, Container, Paper } from '@mui/material';
import ChatIcon from '@mui/icons-material/Chat';
import SchoolIcon from '@mui/icons-material/School';
import SportsEsportsIcon from '@mui/icons-material/SportsEsports';

const PodRedirect = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  
  useEffect(() => {
    // Set loading to false after a short delay
    const timer = setTimeout(() => {
      setLoading(false);
    }, 500);
    
    return () => clearTimeout(timer);
  }, []);
  
  const handleNavigate = (podType) => {
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
      <Paper elevation={3} sx={{ p: 4, borderRadius: 2 }}>
        <Typography variant="h4" gutterBottom align="center">
          Choose a Pod Category
        </Typography>
        <Typography variant="body1" paragraph align="center" color="textSecondary">
          Select the type of pod you want to explore
        </Typography>
        
        <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, gap: 3, mt: 4, justifyContent: 'center' }}>
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
        </Box>
      </Paper>
    </Container>
  );
};

export default PodRedirect; 