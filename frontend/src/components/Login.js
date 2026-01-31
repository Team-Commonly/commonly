import React, { useState } from 'react';
import axios from 'axios';
import { Link } from 'react-router-dom';
import { Box, TextField, Button, Typography, Container, Paper, CircularProgress } from '@mui/material';
import commonlyLogo from '../assets/commonly-logo.png';

const Login = () => {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setLoading(true);

        try {
            const res = await axios.post(`/api/auth/login`, {
                email,
                password,
            });

            // Check if email is verified
            if (!res.data.verified) {
                setError('Please verify your email before logging in.');
                setLoading(false);
                return;
            }

            // Store token
            localStorage.setItem('token', res.data.token);
            
            // Use window.location.href for a complete page reload
            // This ensures the app context is properly initialized
            window.location.href = '/feed';
        } catch (err) {
            setError(err.response?.data?.error || 'Login failed. Please check your credentials.');
            setLoading(false);
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
                            A shared home for team context.
                        </Typography>
                        <Typography variant="body1" sx={{ color: 'rgba(226, 232, 240, 0.92)' }}>
                            Commonly is a place for teams to collect decisions, summaries, and skills
                            so every agent and teammate works from the same memory.
                        </Typography>
                        <Box sx={{ display: 'grid', gap: 1 }}>
                            {[
                                'Capture decisions and daily logs in one place',
                                'Search pod memory across chats and integrations',
                                'Install agents that learn from your team',
                            ].map((item) => (
                                <Typography key={item} variant="body2" sx={{ color: 'rgba(226, 232, 240, 0.85)' }}>
                                    • {item}
                                </Typography>
                            ))}
                        </Box>
                    </Box>
                    <Box sx={{ p: { xs: 4, md: 5 }, backgroundColor: '#0f172a' }}>
                        <Typography variant="h4" component="h2" gutterBottom sx={{ color: '#f8fafc', fontWeight: 700 }}>
                            Login
                        </Typography>
                        <Typography variant="body2" sx={{ color: 'rgba(226, 232, 240, 0.85)', mb: 3 }}>
                            Welcome back. Sign in to your pod dashboard.
                        </Typography>
                        <form onSubmit={handleSubmit} className="auth-form">
                            <TextField
                                fullWidth
                                margin="normal"
                                type="email"
                                label="Email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                required
                                disabled={loading}
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
                                disabled={loading}
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
                                disabled={loading}
                            >
                                {loading ? <CircularProgress size={24} /> : 'Login'}
                            </Button>
                            {error && (
                                <Typography color="error" align="center" sx={{ mt: 2 }}>
                                    {error}
                                </Typography>
                            )}
                            <Typography variant="body2" align="center" sx={{ mt: 2, color: 'rgba(226, 232, 240, 0.85)' }}>
                                Don&apos;t have an account? <Link to="/register" style={{ color: '#93c5fd' }}>Register here</Link>
                            </Typography>
                        </form>
                    </Box>
                </Paper>
            </Container>
        </Box>
    );
};

export default Login;
