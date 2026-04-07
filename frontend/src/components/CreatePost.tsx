import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import './CreatePost.css';
import EmojiEmotionsIcon from '@mui/icons-material/EmojiEmotions';
import EmojiPicker from 'emoji-picker-react';
import { IconButton, Box, Chip, TextField, Autocomplete } from '@mui/material';
import { useAppContext } from '../context/AppContext';
import { refreshPage } from '../utils/refreshUtils';

interface PodOption {
  _id: string;
  name: string;
}

interface EmojiObject {
  emoji?: string;
  unified?: string;
}

const CreatePost: React.FC = () => {
    const { refreshData } = useAppContext();
    const [content, setContent] = useState('');
    const [error, setError] = useState('');
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);
    const [tags, setTags] = useState<string[]>([]);
    const [userPods, setUserPods] = useState<PodOption[]>([]);
    const [selectedPodId, setSelectedPodId] = useState('global');
    const [category, setCategory] = useState('General');
    const navigate = useNavigate();
    const CATEGORY_OPTIONS = ['General', 'Announcements', 'Ideas', 'Help', 'Resources', 'Social'];

    useEffect(() => {
        // Extract hashtags from content
        const extractedTags = content.match(/#[\w]+/g) || [];
        setTags(extractedTags.map(tag => tag.slice(1))); // Remove # from tags
    }, [content]);

    useEffect(() => {
        const fetchPods = async () => {
            try {
                const res = await axios.get('/api/pods', {
                    headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
                });
                setUserPods(res.data || []);
            } catch (err) {
                setUserPods([]);
            }
        };
        fetchPods();
    }, []);

    const podOptions: PodOption[] = [{ _id: 'global', name: 'Global feed' }, ...(userPods || [])];
    const selectedPodOption = podOptions.find((pod) => pod._id === selectedPodId) || podOptions[0];

    const handleSubmit = async (e: React.FormEvent): Promise<void> => {
        e.preventDefault();
        try {
            const resolvedPodId = selectedPodId && selectedPodId !== 'global' ? selectedPodId : null;
            const payload = {
                content,
                tags,
                category: category || 'General',
                ...(resolvedPodId ? { podId: resolvedPodId } : {})
            };
            await axios.post('/api/posts', payload, {
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
    const onEmojiClick = (emojiObj: EmojiObject): void => {
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
                            <EmojiPicker onEmojiClick={onEmojiClick as Parameters<typeof EmojiPicker>[0]['onEmojiClick']} />
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
                    <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mb: 2 }}>
                        <Autocomplete<PodOption, false, true>
                            size="small"
                            options={podOptions}
                            value={selectedPodOption}
                            onChange={(_, value) => setSelectedPodId(value._id || 'global')}
                            getOptionLabel={(option) => option?.name || 'Global feed'}
                            isOptionEqualToValue={(option, value) => option._id === value._id}
                            disableClearable
                            sx={{ minWidth: 220 }}
                            renderInput={(params) => (
                                <TextField
                                    {...params}
                                    label="Post to"
                                />
                            )}
                        />
                        <TextField
                            size="small"
                            label="Category"
                            value={category}
                            onChange={(e) => setCategory(e.target.value)}
                            sx={{ minWidth: 180 }}
                        />
                    </Box>
                    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 2 }}>
                        {CATEGORY_OPTIONS.map((option) => (
                            <Chip
                                key={option}
                                label={option}
                                size="small"
                                variant={category === option ? 'filled' : 'outlined'}
                                onClick={() => setCategory(option)}
                            />
                        ))}
                    </Box>
                    <button type="submit" className="create-post-button">Post</button>
                </Box>
            </form>
        </div>
    );
};

export default CreatePost;
