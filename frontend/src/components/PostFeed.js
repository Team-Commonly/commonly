import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Link } from 'react-router-dom';
import { Typography, Card, CardContent, Avatar, Box, Button, Divider, Container } from '@mui/material';
import { formatDistanceToNow } from 'date-fns';
import { Add as AddIcon } from '@mui/icons-material';

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

    if (error) return <Typography color="error" sx={{ p: 2 }}>{error}</Typography>;

    return (
        <Container maxWidth="md" sx={{ py: 4 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
                <Typography variant="h4" component="h1" gutterBottom>
                    Post Feed
                </Typography>
                <Button 
                    variant="contained" 
                    color="primary" 
                    component={Link} 
                    to="/create-post"
                    startIcon={<AddIcon />}
                >
                    Create Post
                </Button>
            </Box>
            
            {posts.length === 0 ? (
                <Typography variant="body1" sx={{ textAlign: 'center', py: 4 }}>
                    No posts yet!
                </Typography>
            ) : (
                posts.map(post => (
                    <Card key={post._id} sx={{ mb: 3, borderRadius: 2 }}>
                        <CardContent>
                            <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                                <Avatar sx={{ bgcolor: 'primary.main', mr: 2 }}>
                                    {post.userId.username.charAt(0).toUpperCase()}
                                </Avatar>
                                <Box>
                                    <Typography variant="h6">{post.userId.username}</Typography>
                                    {post.createdAt && (
                                        <Typography variant="caption" color="text.secondary">
                                            {formatDistanceToNow(new Date(post.createdAt))} ago
                                        </Typography>
                                    )}
                                </Box>
                            </Box>
                            <Divider sx={{ my: 1.5 }} />
                            <Typography variant="body1" sx={{ mt: 2, mb: 2 }}>
                                {post.content}
                            </Typography>
                            <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                                <Button 
                                    component={Link} 
                                    to={`/thread/${post._id}`}
                                    color="primary"
                                    size="small"
                                >
                                    View Discussion
                                </Button>
                            </Box>
                        </CardContent>
                    </Card>
                ))
            )}
        </Container>
    );
};

export default PostFeed;
