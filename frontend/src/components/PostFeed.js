import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Link, useOutletContext, useNavigate } from 'react-router-dom';
import { Typography, Avatar, Box, Button, Container, IconButton, Menu, MenuItem } from '@mui/material';
import { formatDistanceToNow } from 'date-fns';
import { Add as AddIcon, ChatBubbleOutline, FavoriteBorder, Favorite, MoreVert } from '@mui/icons-material';
import { getAvatarColor } from '../utils/avatarUtils';
import { useAppContext } from '../context/AppContext';
import { blurActiveElement } from '../utils/focusUtils';

const PostFeed = () => {
    const { currentUser, posts: contextPosts, setPosts: setContextPosts, refreshData } = useAppContext();
    const [posts, setPosts] = useState([]);
    const [error, setError] = useState('');
    const [likedPosts, setLikedPosts] = useState({});
    const [menuAnchorEl, setMenuAnchorEl] = useState(null);
    const [selectedPostId, setSelectedPostId] = useState(null);
    const searchResults = useOutletContext();
    const navigate = useNavigate();
    
    const handleLike = async (postId) => {
        // Get the current liked state for this post
        const isCurrentlyLiked = likedPosts[postId] || false;
        
        try {
            // Optimistically update UI
            setLikedPosts({
                ...likedPosts,
                [postId]: !isCurrentlyLiked
            });
            
            // Send request to server
            const response = await axios.post(`/api/posts/${postId}/like`, {}, {
                headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
            });
            
            // Update post likes count
            setPosts(posts.map(post => {
                if (post._id === postId) {
                    return { ...post, likes: response.data.likes };
                }
                return post;
            }));
            
            // If server response doesn't match our optimistic update, correct it
            if (response.data.liked !== !isCurrentlyLiked) {
                setLikedPosts({
                    ...likedPosts,
                    [postId]: response.data.liked
                });
            }
        } catch (err) {
            console.error('Failed to like post:', err);
            // Revert UI change if request fails
            setLikedPosts({
                ...likedPosts,
                [postId]: isCurrentlyLiked
            });
        }
    };

    const handleMenuOpen = (event, postId) => {
        event.stopPropagation();
        setMenuAnchorEl(event.currentTarget);
        setSelectedPostId(postId);
    };

    const handleMenuClose = () => {
        setMenuAnchorEl(null);
        setSelectedPostId(null);
        blurActiveElement();
    };

    const handleDeletePost = async () => {
        if (!selectedPostId) return;
        
        try {
            await axios.delete(`/api/posts/${selectedPostId}`, {
                headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
            });
            
            // Remove the deleted post from the local state
            setPosts(posts.filter(post => post._id !== selectedPostId));
            
            // Remove the deleted post from the context state
            setContextPosts(contextPosts.filter(post => post._id !== selectedPostId));
            
            handleMenuClose();
            
            // Refresh data to ensure consistency
            refreshData();
        } catch (err) {
            console.error('Failed to delete post:', err);
        }
    };

    useEffect(() => {
        if (searchResults !== null) {
            setPosts(searchResults);
            
            // Check which posts the current user has liked
            if (currentUser) {
                const likedStatus = {};
                searchResults.forEach(post => {
                    if (post.likedBy && post.likedBy.includes(currentUser._id)) {
                        likedStatus[post._id] = true;
                    } else {
                        likedStatus[post._id] = false;
                    }
                });
                
                setLikedPosts(likedStatus);
            }
        } else {
            // Use posts from context if available
            if (contextPosts.length > 0) {
                setPosts(contextPosts);
                
                // Check which posts the current user has liked
                if (currentUser) {
                    const likedStatus = {};
                    contextPosts.forEach(post => {
                        if (post.likedBy && post.likedBy.includes(currentUser._id)) {
                            likedStatus[post._id] = true;
                        } else {
                            likedStatus[post._id] = false;
                        }
                    });
                    
                    setLikedPosts(likedStatus);
                }
            } else {
                const fetchPosts = async () => {
                    try {
                        const res = await axios.get('/api/posts', {
                            headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
                        });
                        setPosts(res.data);
                        setContextPosts(res.data);
                        
                        // Check which posts the current user has liked
                        if (currentUser) {
                            const likedStatus = {};
                            res.data.forEach(post => {
                                if (post.likedBy && post.likedBy.includes(currentUser._id)) {
                                    likedStatus[post._id] = true;
                                } else {
                                    likedStatus[post._id] = false;
                                }
                            });
                            
                            setLikedPosts(likedStatus);
                        }
                    } catch (err) {
                        setError('Failed to fetch posts. Please try again later.');
                        setPosts([]);
                    }
                };
                fetchPosts();
            }
        }
    }, [searchResults, currentUser, contextPosts, setContextPosts]);

    if (error) return <Typography color="error" sx={{ p: 2, mt: 8 }}>{error}</Typography>;

    return (
        <Container maxWidth="md" sx={{ py: 4, mt: 8 }}>
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
                    <div key={post._id} className="post-card">
                        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
                            <Avatar sx={{ 
                                bgcolor: getAvatarColor(post.userId.profilePicture),
                            }}>
                                {post.userId.username.charAt(0).toUpperCase()}
                            </Avatar>
                            <Box sx={{ flex: 1 }}>
                                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.5 }}>
                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                        <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
                                            {post.userId.username}
                                        </Typography>
                                        {post.createdAt && (
                                            <Typography variant="body2" color="text.secondary">
                                                · {formatDistanceToNow(new Date(post.createdAt))} ago
                                            </Typography>
                                        )}
                                    </Box>
                                    {currentUser && (currentUser._id === post.userId._id) && (
                                        <IconButton 
                                            size="small" 
                                            onClick={(e) => handleMenuOpen(e, post._id)}
                                            aria-label="post options"
                                            id="post-options-button"
                                        >
                                            <MoreVert />
                                        </IconButton>
                                    )}
                                </Box>
                                <Typography variant="body1" sx={{ mb: 2, whiteSpace: 'pre-wrap', textAlign: 'left' }}>                                    
                                    {post.content.split(/(#\w+)/g).map((part, index) => {
                                        if (part.startsWith('#')) {
                                            return (
                                                <Typography
                                                    key={index}
                                                    component="span"
                                                    color="primary"
                                                    onClick={() => {
                                                        // Remove the # symbol for the search query
                                                        const tag = part.substring(1);
                                                        navigate(`/feed?tags=${tag}`);
                                                    }}
                                                    sx={{ '&:hover': { textDecoration: 'underline', cursor: 'pointer' } }}
                                                >
                                                    {part}
                                                </Typography>
                                            );
                                        }
                                        return part;
                                    })}
                                </Typography>
                                <Box sx={{ display: 'flex', gap: 3, alignItems: 'center' }}>
                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                        <IconButton 
                                            onClick={() => handleLike(post._id)} 
                                            size="small" 
                                            color="primary"
                                        >
                                            {likedPosts[post._id] ? <Favorite /> : <FavoriteBorder />}
                                        </IconButton>
                                        <Typography variant="body2" color="text.secondary">
                                            {post.likes || 0}
                                        </Typography>
                                    </Box>
                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                        <IconButton 
                                            component={Link} 
                                            to={`/thread/${post._id}`} 
                                            size="small" 
                                            color="primary"
                                        >
                                            <ChatBubbleOutline />
                                        </IconButton>
                                        <Typography variant="body2" color="text.secondary">
                                            {post.comments?.length || 0}
                                        </Typography>
                                    </Box>
                                </Box>

                            </Box>
                        </Box>
                    </div>
                ))
            )}
            
            <Menu
                anchorEl={menuAnchorEl}
                open={Boolean(menuAnchorEl)}
                onClose={handleMenuClose}
                disableRestoreFocus
                keepMounted
                MenuListProps={{
                    'aria-labelledby': 'post-options-button',
                    autoFocusItem: false,
                }}
                slotProps={{
                    backdrop: {
                        onClick: handleMenuClose
                    }
                }}
            >
                <MenuItem 
                    onClick={handleDeletePost}
                    tabIndex={0}
                >
                    Delete
                </MenuItem>
            </Menu>
        </Container>
    );
};

export default PostFeed;
