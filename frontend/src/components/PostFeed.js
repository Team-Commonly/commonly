import React, { useEffect, useState } from 'react';
import axios from 'axios';

const PostFeed = () => {
    const [posts, setPosts] = useState([]);
    const [error, setError] = useState('');

    useEffect(() => {
        const fetchPosts = async () => {
            try {
                const res = await axios.get(`/api/posts`, {
                    headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
                });
                setPosts(res.data);
            } catch (err) {
                setError('Failed to fetch posts. Please try again later.');
            }
        };
        fetchPosts();
    }, []);

    return (
        <div>
            {error ? <p style={{ color: 'red' }}>{error}</p> : null}
            {posts.length === 0 && !error ? <p>No posts yet!</p> : null}
            {posts.map((post) => (
                <div key={post._id}>
                    <h3>{post.userId.username}</h3>
                    <p>{post.content}</p>
                </div>
            ))}
        </div>
    );
};

export default PostFeed;
