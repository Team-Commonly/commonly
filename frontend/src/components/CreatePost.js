import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import './CreatePost.css';
import EmojiEmotionsIcon from '@mui/icons-material/EmojiEmotions';
import EmojiPicker from 'emoji-picker-react';
import { IconButton, Box, Chip } from '@mui/material';
import { useAppContext } from '../context/AppContext';
import { refreshPage } from '../utils/refreshUtils';

const CreatePost = () => {
    const { refreshData } = useAppContext();
    const [content, setContent] = useState('');
    const [error, setError] = useState('');
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);
    const [tags, setTags] = useState([]);
    const navigate = useNavigate();

    useEffect(() => {
        // Extract hashtags from content
        const extractedTags = content.match(/#[\w]+/g) || [];
        setTags(extractedTags.map(tag => tag.slice(1))); // Remove # from tags
    }, [content]);

    const handleSubmit = async (e) => {
        e.preventDefault();
        try {
            await axios.post('/api/posts', { content, tags }, {
                headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
            });
            
            // Refresh data to ensure consistency
            refreshData();
            
            // Navigate to feed
            navigate('/feed');
            
            // Trigger a page refresh after a short delay
            refreshPage(500);
        } catch (err) {
            setError('Failed to create post. Please try again later.');
        }
    };
    const onEmojiClick = (emojiObj) => {
        // Support both older and newer emoji-picker-react versions
        const emoji = emojiObj.emoji || (emojiObj.unified && String.fromCodePoint(parseInt(emojiObj.unified, 16)));
        if (emoji) {
            setContent(prevContent => prevContent + emoji);
        }
    };
    return (
        <div className="create-post-container">
            <h2>Create New Post</h2>
            {error && <p style={{ color: 'red' }}>{error}</p>}
            <form onSubmit={handleSubmit} className="create-post-form">
                <div className="create-post-textarea-container">
                    <textarea
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        placeholder="What's on your mind?"
                        className="create-post-textarea"
                    />
                    <IconButton
                        className="emoji-button"
                        onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                        color="primary"
                    >
                        <EmojiEmotionsIcon />
                    </IconButton>
                    {showEmojiPicker && (
                        <div className="emoji-picker-container">
                            <EmojiPicker onEmojiClick={onEmojiClick} />
                        </div>
                    )}
                </div>
                <Box sx={{ mt: 2 }}>
                    {tags.length > 0 && (
                        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 2 }}>
                            {tags.map((tag, index) => (
                                <Chip
                                    key={index}
                                    label={`#${tag}`}
                                    color="primary"
                                    variant="outlined"
                                    size="small"
                                />
                            ))}
                        </Box>
                    )}
                    <button type="submit" className="create-post-button">Post</button>
                </Box>
            </form>
        </div>
    );
};

export default CreatePost;