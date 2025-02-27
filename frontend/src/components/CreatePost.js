import React, { useState } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import './CreatePost.css'; // Import CSS for styling

const CreatePost = () => {
    const [content, setContent] = useState('');
    const [error, setError] = useState('');
    const navigate = useNavigate();

    const handleSubmit = async (e) => {
        e.preventDefault();
        try {
            await axios.post('/api/posts', { content }, {
                headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
            });
            navigate('/feed');
        } catch (err) {
            setError('Failed to create post. Please try again later.');
        }
    };

    return (
        <div className="create-post-container">
            <h2>Create New Post</h2>
            {error && <p style={{ color: 'red' }}>{error}</p>}
            <form onSubmit={handleSubmit} className="create-post-form">
                <textarea
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder="What's on your mind?"
                    className="create-post-textarea"
                />
                <button type="submit" className="create-post-button">Post</button>
            </form>
        </div>
    );
};

export default CreatePost;