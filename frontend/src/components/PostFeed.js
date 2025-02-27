import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Link } from 'react-router-dom';

const PostFeed = () => {
    const [posts, setPosts] = useState([]);
    const [error, setError] = useState('');

    useEffect(() => {
        const fetchPosts = async () => {
            try {
                const res = await axios.get('/api/posts');
                setPosts(res.data);
            } catch (err) {
                setError('Failed to fetch posts. Please try again later.');
            }
        };
        fetchPosts();
    }, []);

    if (error) return <p style={{ color: 'red' }}>{error}</p>;

    return (
        <div>
            <h2>Post Feed</h2>
            {posts.length === 0 ? (
                <p>No posts yet!</p>
            ) : (
                posts.map(post => (
                    <div key={post._id}>
                        <h3>{post.userId.username}</h3>
                        <p>{post.content}</p>
                    </div>
                ))
            )}
            <Link to="/create-post">
                <button>Create New Post</button>
            </Link>
        </div>
    );
};

export default PostFeed;
