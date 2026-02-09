import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Container,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import axios from '../utils/axiosConfig';
import commonlyLogo from '../assets/commonly-logo.png';

const RegistrationInviteRequired = () => {
  const navigate = useNavigate();
  const [invitationCode, setInvitationCode] = useState('');
  const [waitlistEmail, setWaitlistEmail] = useState('');
  const [waitlistName, setWaitlistName] = useState('');
  const [waitlistNote, setWaitlistNote] = useState('');
  const [waitlistLoading, setWaitlistLoading] = useState(false);
  const [waitlistError, setWaitlistError] = useState('');
  const [waitlistSuccess, setWaitlistSuccess] = useState('');

  const onContinue = (e) => {
    e.preventDefault();
    const trimmed = invitationCode.trim();
    if (!trimmed) return;
    navigate(`/register?invite=${encodeURIComponent(trimmed)}`);
  };

  const onWaitlistSubmit = async (e) => {
    e.preventDefault();
    setWaitlistError('');
    setWaitlistSuccess('');
    try {
      setWaitlistLoading(true);
      const res = await axios.post('/api/auth/waitlist', {
        email: waitlistEmail,
        name: waitlistName,
        note: waitlistNote,
      });
      setWaitlistSuccess(res.data?.message || 'Waitlist request submitted.');
      setWaitlistName('');
      setWaitlistNote('');
    } catch (err) {
      setWaitlistError(err.response?.data?.error || 'Failed to submit waitlist request');
    } finally {
      setWaitlistLoading(false);
    }
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        background: 'radial-gradient(circle at top, rgba(46, 64, 110, 0.15), transparent 55%), linear-gradient(135deg, #0f172a 0%, #111827 45%, #0b1220 100%)',
        display: 'flex',
        alignItems: 'center',
        py: { xs: 6, md: 10 },
      }}
    >
      <Container maxWidth="sm">
        <Paper
          elevation={6}
          sx={{
            borderRadius: 3,
            background: '#0b1220',
            border: '1px solid rgba(148, 163, 184, 0.15)',
            p: { xs: 4, md: 5 },
            textAlign: 'center',
          }}
        >
          <Box
            component="img"
            src={commonlyLogo}
            alt="Commonly logo"
            sx={{
              width: 52,
              height: 52,
              borderRadius: 2,
              backgroundColor: '#0f172a',
              border: '1px solid rgba(148, 163, 184, 0.2)',
              p: 0.75,
              mb: 2,
            }}
          />
          <Typography variant="h4" sx={{ color: '#f8fafc', fontWeight: 700, mb: 1.5 }}>
            Invitation Required
          </Typography>
          <Typography variant="body1" sx={{ color: '#cbd5e1', mb: 3 }}>
            New account registration is currently invite-only. Enter your invitation code to continue,
            or submit a waitlist request for admin review.
          </Typography>
          <Box component="form" onSubmit={onContinue}>
            <TextField
              fullWidth
              label="Invitation Code"
              value={invitationCode}
              onChange={(e) => setInvitationCode(e.target.value)}
              required
              sx={{
                input: { color: '#f8fafc' },
                '& .MuiOutlinedInput-root': {
                  backgroundColor: 'rgba(15, 23, 42, 0.8)',
                  '& fieldset': { borderColor: 'rgba(148, 163, 184, 0.3)' },
                  '&:hover fieldset': { borderColor: 'rgba(148, 163, 184, 0.5)' },
                  '&.Mui-focused fieldset': { borderColor: '#60a5fa' },
                },
                '& .MuiInputLabel-root': { color: 'rgba(226, 232, 240, 0.9)' },
              }}
            />
            <Button
              type="submit"
              fullWidth
              variant="contained"
              sx={{
                mt: 3,
                py: 1.2,
                fontWeight: 600,
                background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)',
              }}
            >
              Continue to Registration
            </Button>
          </Box>
          <Box sx={{ mt: 3, textAlign: 'left' }}>
            <Typography variant="subtitle2" sx={{ color: '#e2e8f0', mb: 1 }}>
              Need access? Join the waitlist
            </Typography>
            {waitlistError && <Alert severity="error" sx={{ mb: 1.25 }}>{waitlistError}</Alert>}
            {waitlistSuccess && <Alert severity="success" sx={{ mb: 1.25 }}>{waitlistSuccess}</Alert>}
            <Box component="form" onSubmit={onWaitlistSubmit}>
              <Stack spacing={1.25}>
                <TextField
                  fullWidth
                  size="small"
                  label="Email"
                  type="email"
                  value={waitlistEmail}
                  onChange={(e) => setWaitlistEmail(e.target.value)}
                  required
                />
                <TextField
                  fullWidth
                  size="small"
                  label="Name (optional)"
                  value={waitlistName}
                  onChange={(e) => setWaitlistName(e.target.value)}
                />
                <TextField
                  fullWidth
                  size="small"
                  label="Use case (optional)"
                  value={waitlistNote}
                  onChange={(e) => setWaitlistNote(e.target.value)}
                />
                <Button type="submit" variant="outlined" disabled={waitlistLoading}>
                  {waitlistLoading ? 'Submitting...' : 'Request Waitlist Access'}
                </Button>
              </Stack>
            </Box>
          </Box>
          <Typography variant="body2" sx={{ mt: 2.5, color: 'rgba(226, 232, 240, 0.85)' }}>
            Already have an account? <Link to="/login" style={{ color: '#93c5fd' }}>Login here</Link>
          </Typography>
        </Paper>
      </Container>
    </Box>
  );
};

export default RegistrationInviteRequired;
