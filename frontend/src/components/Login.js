import React, { useState } from 'react';
import axios from 'axios';
import { useNavigate, Link } from 'react-router-dom';

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
            alert('Logged in successfully');
            navigate('/feed');
        } catch (err) {
            setError(err.response?.data?.error || 'Login failed. Please check your credentials.');
        }
    };

    return (
        <div>
            <form onSubmit={handleSubmit}>
                <input
                    type="email"
                    placeholder="Email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                />
                <input
                    type="password"
                    placeholder="Password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                />
                <button type="submit">Login</button>
            </form>
            {error && <p style={{ color: 'red' }}>{error}</p>}
            
            {/* Add a Register button */}
            <p>
                Don’t have an account? <Link to="/register">Register here</Link>
            </p>
        </div>
    );
};

export default Login;
