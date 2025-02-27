import React, { useEffect, useState } from 'react';
import axios from 'axios';

const UserProfile = () => {
    const [user, setUser] = useState(null);
    const [error, setError] = useState('');

    useEffect(() => {
        const fetchUser = async () => {
            try {
                const res = await axios.get(`/api/auth/profile`, {
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
        <div>
            <h3>{user.username}</h3>
            <p>{user.email}</p>
        </div>
    );
};

export default UserProfile;
