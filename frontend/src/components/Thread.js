import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { useParams } from 'react-router-dom';
import { Card, CardContent, Typography, Avatar, Box, Divider, Paper } from '@mui/material';
import { formatDistanceToNow } from 'date-fns';

const Thread = () => {
    const { id } = useParams();
    const [post, setPost] = useState(null);
    const [error, setError] = useState('');

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

    if (error) return <p style={{ color: 'red' }}>{error}</p>;
    if (!post) return <p>Loading...</p>;

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
                    <Typography variant="body1" sx={{ mt: 2 }}>
                        {post.content}
                    </Typography>
                </CardContent>
            </Card>

            <Typography variant="h6" sx={{ mb: 2 }}>
                Comments ({post.comments.length})
            </Typography>

            {post.comments.map((comment) => (
                <Paper key={comment._id} sx={{ p: 2, mb: 2 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                        <Avatar sx={{ width: 32, height: 32, mr: 1, bgcolor: 'secondary.main' }}>
                            {comment.userId.username.charAt(0).toUpperCase()}
                        </Avatar>
                        <Box>
                            <Typography variant="subtitle2">{comment.userId.username}</Typography>
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
