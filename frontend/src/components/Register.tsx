import React, { useEffect, useMemo, useState } from 'react';
import axios from '../utils/axiosConfig';
import { Box, TextField, Button, Typography, Container, Paper } from '@mui/material';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import commonlyLogo from '../assets/commonly-logo.png';

interface RegistrationPolicy {
  loaded: boolean;
  inviteOnly: boolean;
}

const Register: React.FC = () => {
  const [searchParams] = useSearchParams();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [invitationCode, setInvitationCode] = useState(searchParams.get('invite') || '');
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);
  const [policy, setPolicy] = useState<RegistrationPolicy>({
    loaded: false,
    inviteOnly: false,
  });

  useEffect(() => {
    let isMounted = true;
    axios.get('/api/auth/registration-policy')
      .then((res) => {
        if (!isMounted) return;
        setPolicy({
          loaded: true,
          inviteOnly: Boolean(res.data?.inviteOnly),
        });
      })
      .catch(() => {
        if (!isMounted) return;
        setPolicy({ loaded: true, inviteOnly: false });
      });
    return () => {
      isMounted = false;
    };
  }, []);

  const hasInviteFromUrl = useMemo(() => Boolean(searchParams.get('invite')), [searchParams]);

  if (policy.loaded && policy.inviteOnly && !hasInviteFromUrl) {
    return <Navigate to="/register/invite-required" replace />;
  }

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setMessage('');
    setIsError(false);

    try {
      const res = await axios.post(`/api/auth/register`, {
        username,
        email,
        password,
        invitationCode: invitationCode.trim(),
      });
      setMessage(res.data.message);
    } catch (err) {
      setIsError(true);
      const e = err as { response?: { data?: { error?: string } } };
      setMessage(e.response?.data?.error || "Registration failed.");
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
      <Container maxWidth="md">
        <Paper
          elevation={6}
          sx={{
            overflow: 'hidden',
            borderRadius: 3,
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', md: '1fr 1.1fr' },
            background: '#0b1220',
            border: '1px solid rgba(148, 163, 184, 0.15)',
          }}
        >
          <Box
            sx={{
              p: { xs: 4, md: 5 },
              background: 'linear-gradient(160deg, rgba(59, 130, 246, 0.15), rgba(15, 23, 42, 0.8))',
              borderRight: { md: '1px solid rgba(148, 163, 184, 0.12)' },
              display: 'flex',
              flexDirection: 'column',
              gap: 2.5,
              color: '#e2e8f0',
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
              <Box
                component="img"
                src={commonlyLogo}
                alt="Commonly logo"
                sx={{
                  width: 48,
                  height: 48,
                  borderRadius: 2,
                  backgroundColor: '#0f172a',
                  border: '1px solid rgba(148, 163, 184, 0.2)',
                  p: 0.75,
                }}
              />
              <Typography variant="h5" component="div" sx={{ fontWeight: 700 }}>
                Commonly
              </Typography>
            </Box>
            <Typography variant="h4" component="h1" sx={{ fontWeight: 700 }}>
              Set up your shared memory space.
            </Typography>
            <Typography variant="body1" sx={{ color: 'rgba(226, 232, 240, 0.92)' }}>
              Create your account to start capturing team decisions, summaries, and skills in one place.
            </Typography>
            <Box sx={{ display: 'grid', gap: 1 }}>
              {[
                'Start a pod and invite your teammates',
                'Turn activity into searchable team memory',
                'Power agents with trusted context',
              ].map((item) => (
                <Typography key={item} variant="body2" sx={{ color: 'rgba(226, 232, 240, 0.85)' }}>
                  &bull; {item}
                </Typography>
              ))}
            </Box>
          </Box>
          <Box sx={{ p: { xs: 4, md: 5 }, backgroundColor: '#0f172a' }}>
            <Typography variant="h4" component="h2" gutterBottom sx={{ color: '#f8fafc', fontWeight: 700 }}>
              Register
            </Typography>
            <Typography variant="body2" sx={{ color: 'rgba(226, 232, 240, 0.85)', mb: 3 }}>
              Create your account to join or launch a pod.
            </Typography>
            <form onSubmit={onSubmit} className="auth-form">
              {policy.inviteOnly && (
                <TextField
                  fullWidth
                  margin="normal"
                  label="Invitation Code"
                  value={invitationCode}
                  onChange={(e) => setInvitationCode(e.target.value)}
                  required
                  helperText="Registration is invite-only. Enter a valid invitation code."
                  InputLabelProps={{ style: { color: 'rgba(226, 232, 240, 0.9)' } }}
                  FormHelperTextProps={{ style: { color: 'rgba(148, 163, 184, 0.85)' } }}
                  sx={{
                    input: { color: '#f8fafc' },
                    '& .MuiOutlinedInput-root': {
                      backgroundColor: 'rgba(15, 23, 42, 0.8)',
                      '& fieldset': { borderColor: 'rgba(148, 163, 184, 0.3)' },
                      '&:hover fieldset': { borderColor: 'rgba(148, 163, 184, 0.5)' },
                      '&.Mui-focused fieldset': { borderColor: '#60a5fa' },
                    },
                  }}
                />
              )}
              <TextField
                fullWidth
                margin="normal"
                label="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                InputLabelProps={{ style: { color: 'rgba(226, 232, 240, 0.9)' } }}
                sx={{
                  input: { color: '#f8fafc' },
                  '& .MuiOutlinedInput-root': {
                    backgroundColor: 'rgba(15, 23, 42, 0.8)',
                    '& fieldset': { borderColor: 'rgba(148, 163, 184, 0.3)' },
                    '&:hover fieldset': { borderColor: 'rgba(148, 163, 184, 0.5)' },
                    '&.Mui-focused fieldset': { borderColor: '#60a5fa' },
                  },
                }}
              />
              <TextField
                fullWidth
                margin="normal"
                type="email"
                label="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                InputLabelProps={{ style: { color: 'rgba(226, 232, 240, 0.9)' } }}
                sx={{
                  input: { color: '#f8fafc' },
                  '& .MuiOutlinedInput-root': {
                    backgroundColor: 'rgba(15, 23, 42, 0.8)',
                    '& fieldset': { borderColor: 'rgba(148, 163, 184, 0.3)' },
                    '&:hover fieldset': { borderColor: 'rgba(148, 163, 184, 0.5)' },
                    '&.Mui-focused fieldset': { borderColor: '#60a5fa' },
                  },
                }}
              />
              <TextField
                fullWidth
                margin="normal"
                type="password"
                label="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                InputLabelProps={{ style: { color: 'rgba(226, 232, 240, 0.9)' } }}
                sx={{
                  input: { color: '#f8fafc' },
                  '& .MuiOutlinedInput-root': {
                    backgroundColor: 'rgba(15, 23, 42, 0.8)',
                    '& fieldset': { borderColor: 'rgba(148, 163, 184, 0.3)' },
                    '&:hover fieldset': { borderColor: 'rgba(148, 163, 184, 0.5)' },
                    '&.Mui-focused fieldset': { borderColor: '#60a5fa' },
                  },
                }}
              />
              <Button
                type="submit"
                fullWidth
                variant="contained"
                sx={{
                  mt: 3,
                  mb: 2,
                  py: 1.2,
                  fontWeight: 600,
                  background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)',
                }}
              >
                Register
              </Button>
              {message && (
                <Typography
                  color={isError ? 'error' : 'success'}
                  align="center"
                  sx={{ mt: 2 }}
                >
                  {message}
                </Typography>
              )}
              <Typography variant="body2" align="center" sx={{ mt: 2, color: 'rgba(226, 232, 240, 0.85)' }}>
                Already have an account? <Link to="/login" style={{ color: '#93c5fd' }}>Login here</Link>
              </Typography>
            </form>
          </Box>
        </Paper>
      </Container>
    </Box>
  );
};

export default Register;
