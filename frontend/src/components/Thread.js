import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, CardContent, Typography, Avatar, Box, Divider, Paper, Button, IconButton, Chip } from '@mui/material';
import { formatDistanceToNow } from 'date-fns';
import EmojiEmotionsIcon from '@mui/icons-material/EmojiEmotions';
import EmojiPicker from 'emoji-picker-react';
import './Thread.css';

const Thread = () => {
    const { id } = useParams();
    const navigate = useNavigate();
    const [post, setPost] = useState(null);
    const [error, setError] = useState('');
    const [comment, setComment] = useState('');
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);

    useEffect(() => {
        const fetchPost = async () => {
            try {
                const res = await axios.get(`/api/posts/${id}`);
                setPost(res.data);
            } catch (err) {
                setError('Failed to fetch post. Please try again later.');
            }
        };
        fetchPost();
    }, [id]);

    const handleCommentSubmit = async (e) => {
        e.preventDefault();
        if (!comment.trim()) return;
    
        try {
            const res = await axios.post(`/api/posts/${id}/comments`, 
                { text: comment },
                { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } }
            );
            setPost(prevPost => ({
                ...prevPost,
                comments: [...prevPost.comments, res.data]
            }));
            setComment('');
            setShowEmojiPicker(false);
        } catch (err) {
            setError('Failed to post comment. Please try again.');
        }
    };

    const onEmojiClick = (emojiData) => {
        setComment(prevComment => prevComment + emojiData.emoji);
    };

    if (error) return <Typography color="error" sx={{ p: 2 }}>{error}</Typography>;
    if (!post) return <Typography sx={{ p: 2 }}>Loading...</Typography>;

    return (
        <Box sx={{ maxWidth: 800, mx: 'auto', p: 3 }}>
            <Card sx={{ mb: 4 }}>
                <CardContent>
                    <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                        <Avatar sx={{ bgcolor: 'primary.main', mr: 2 }}>
                            {post.userId.username.charAt(0).toUpperCase()}
                        </Avatar>
                        <Box>
                            <Typography variant="h6">{post.userId.username}</Typography>
                            <Typography variant="caption" color="text.secondary">
                                {formatDistanceToNow(new Date(post.createdAt))} ago
                            </Typography>
                        </Box>
                    </Box>
                    <Typography variant="body1" sx={{ mt: 2, mb: 2 }}>
                        {post.content}
                    </Typography>
                    {post.tags && post.tags.length > 0 && (
                        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 1 }}>
                            {post.tags.map((tag, index) => (
                                <Chip
                                    key={index}
                                    label={tag}
                                    size="small"
                                    color="primary"
                                    variant="outlined"
                                    onClick={() => navigate(`/feed?tags=${tag}`)}
                                />
                            ))}
                        </Box>
                    )}
                </CardContent>
            </Card>

            <Divider sx={{ mb: 3 }} />

            <div className="thread-comment-form">
                <form onSubmit={handleCommentSubmit}>
                    <div className="comment-input-container">
                        <textarea
                            className="comment-textarea"
                            value={comment}
                            onChange={(e) => setComment(e.target.value)}
                            placeholder="Write a comment..."
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
                    <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 2 }}>
                        <Button
                            type="submit"
                            variant="contained"
                            color="primary"
                            disabled={!comment.trim()}
                        >
                            Post Comment
                        </Button>
                    </Box>
                </form>
            </div>

            <Typography variant="h6" sx={{ mb: 2 }}>
                Comments ({post.comments.length})
            </Typography>

            {post.comments.map((comment) => (
                <Paper key={comment._id} sx={{ p: 2, mb: 2 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                        <Avatar sx={{ width: 32, height: 32, mr: 1, bgcolor: 'primary.main' }}>
                            {comment.userId && comment.userId.username ? comment.userId.username.charAt(0).toUpperCase() : '?'}
                        </Avatar>
                        <Box>
                            <Typography variant="subtitle2">{comment.userId && comment.userId.username ? comment.userId.username : 'Unknown User'}</Typography>
                            <Typography variant="caption" color="text.secondary">
                                {formatDistanceToNow(new Date(comment.createdAt))} ago
                            </Typography>
                        </Box>
                    </Box>
                    <Typography variant="body2" sx={{ mt: 1 }}>
                        {comment.text}
                    </Typography>
                </Paper>
            ))}
        </Box>
    );
};

export default Thread;
