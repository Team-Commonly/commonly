import React, { useState } from 'react';
import axios from 'axios';
import { useNavigate, Link } from 'react-router-dom';
import { Box, TextField, Button, Typography, Container, Paper } from '@mui/material';

const Login = () => {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const navigate = useNavigate();

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');

        try {
            const res = await axios.post(`/api/auth/login`, {
                email,
                password,
            });

            // Check if email is verified
            if (!res.data.verified) {
                setError('Please verify your email before logging in.');
                return;
            }

            // Store token and redirect to feed
            localStorage.setItem('token', res.data.token);
            navigate('/feed');
        } catch (err) {
            setError(err.response?.data?.error || 'Login failed. Please check your credentials.');
        }
    };

    return (
        <Container maxWidth="sm">
            <Box sx={{ mt: 8, mb: 4 }}>
                <Paper elevation={3} sx={{ p: 4 }}>
                    <Typography variant="h4" component="h1" gutterBottom align="center">
                        Login
                    </Typography>
                    <form onSubmit={handleSubmit}>
                        <TextField
                            fullWidth
                            margin="normal"
                            type="email"
                            label="Email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            required
                        />
                        <TextField
                            fullWidth
                            margin="normal"
                            type="password"
                            label="Password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                        />
                        <Button
                            type="submit"
                            fullWidth
                            variant="contained"
                            sx={{ mt: 3, mb: 2 }}
                        >
                            Login
                        </Button>
                        {error && (
                            <Typography 
                                color="error"
                                align="center"
                                sx={{ mt: 2 }}
                            >
                                {error}
                            </Typography>
                        )}
                        <Typography variant="body2" align="center" sx={{ mt: 2 }}>
                            Don't have an account? <Link to="/register">Register here</Link>
                        </Typography>
                    </form>
                </Paper>
            </Box>
        </Container>
    );
};

export default Login;
