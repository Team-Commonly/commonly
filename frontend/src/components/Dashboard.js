import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Link } from 'react-router-dom';

const Dashboard = () => {
    const [user, setUser] = useState(null);
    const [error, setError] = useState('');

    useEffect(() => {
        const fetchUser = async () => {
            try {
                const res = await axios.get('/api/auth/profile', {
                    headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
                });
                setUser(res.data);
            } catch (err) {
                setError('Failed to fetch user profile. Please try again later.');
            }
        };
        fetchUser();
    }, []);

    if (error) return <p style={{ color: 'red' }}>{error}</p>;
    if (!user) return <p>Loading...</p>;

    return (
        <div className="dashboard-container">
            <h2>Welcome, {user.username}!</h2>
            <nav>
                <ul>
                    <li><Link to="/feed">Post Feed</Link></li>
                    <li><Link to="/profile">Profile</Link></li>
                    <li><Link to="/create-post">Create Post</Link></li>
                </ul>
            </nav>
        </div>
    );
};

export default Dashboard;