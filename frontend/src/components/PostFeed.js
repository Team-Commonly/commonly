import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Link, useOutletContext, useNavigate } from 'react-router-dom';
import { 
    Typography, Avatar, Box, Button, Container, IconButton, Menu, MenuItem, 
    Paper, TextField, Divider, CircularProgress, Skeleton, Card, CardContent
} from '@mui/material';
import { formatDistanceToNow } from 'date-fns';
import { 
    Add as AddIcon, 
    ChatBubbleOutline, 
    FavoriteBorder, 
    Favorite, 
    MoreVert,
    EmojiEmotions as EmojiEmotionsIcon,
    Image as ImageIcon,
    Send as SendIcon
} from '@mui/icons-material';
import { getAvatarColor } from '../utils/avatarUtils';
import { useAppContext } from '../context/AppContext';
import { blurActiveElement } from '../utils/focusUtils';
import EmojiPicker from 'emoji-picker-react';
import './PostFeed.css'; // Import the CSS file

const PostFeed = () => {
    const { 
        currentUser, 
        posts: contextPosts, 
        setPosts: setContextPosts, 
        refreshData,
        removePost,
        postsLoading
    } = useAppContext();
    const [posts, setPosts] = useState([]);
    const [error, setError] = useState('');
    const [likedPosts, setLikedPosts] = useState({});
    const [menuAnchorEl, setMenuAnchorEl] = useState(null);
    const [selectedPostId, setSelectedPostId] = useState(null);
    const searchResults = useOutletContext();
    const navigate = useNavigate();
    
    // Create post state
    const [postContent, setPostContent] = useState('');
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [tags, setTags] = useState([]);
    
    // Extract hashtags from content
    useEffect(() => {
        const extractedTags = postContent.match(/#[\w]+/g) || [];
        setTags(extractedTags.map(tag => tag.slice(1))); // Remove # from tags
    }, [postContent]);
    
    const handleCreatePost = async (e) => {
        e.preventDefault();
        if (!postContent.trim()) return;
        
        setIsSubmitting(true);
        try {
            await axios.post('/api/posts', { content: postContent, tags }, {
                headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
            });
            
            // Clear the form
            setPostContent('');
            setTags([]);
            
            // Refresh data to ensure consistency
            window.location.reload();
        } catch (err) {
            setError('Failed to create post. Please try again later.');
        } finally {
            setIsSubmitting(false);
        }
    };
    
    const onEmojiClick = (emojiData) => {
        setPostContent(prevContent => prevContent + emojiData.emoji);
    };
    
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
            // Close the menu first
            handleMenuClose();
            
            // Remove the post from local state
            setPosts(posts.filter(post => post._id !== selectedPostId));
            
            // Remove the post from context state using the new helper function
            removePost(selectedPostId);
            
            // Send the delete request to the server
            await axios.delete(`/api/posts/${selectedPostId}`, {
                headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
            });
            
            // Trigger a page refresh after a short delay
            refreshPage(500);
        } catch (err) {
            console.error('Failed to delete post:', err);
            // If there's an error, revert the UI changes by refreshing the data
            refreshData();
        }
    };

    // Define the fetch posts function
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
                    // Check if likedBy contains the current user's ID
                    const isLiked = post.likedBy && post.likedBy.some(user => 
                        user._id === currentUser._id || user === currentUser._id
                    );
                    likedStatus[post._id] = isLiked;
                });
                
                setLikedPosts(likedStatus);
            }
        } catch (err) {
            setError('Failed to fetch posts. Please try again later.');
            setPosts([]);
        }
    };

    // If we have search results, use them
    useEffect(() => {
        if (searchResults !== null) {
            setPosts(searchResults);
            
            // Check which posts the current user has liked
            if (currentUser) {
                const likedStatus = {};
                searchResults.forEach(post => {
                    // Check if likedBy contains the current user's ID
                    const isLiked = post.likedBy && post.likedBy.some(user => 
                        user._id === currentUser._id || user === currentUser._id
                    );
                    likedStatus[post._id] = isLiked;
                });
                
                setLikedPosts(likedStatus);
            }
        } 
        // Otherwise, if we have the current user, fetch posts
        else if (currentUser) {
            fetchPosts();
        }
    }, [searchResults, currentUser, setContextPosts]);

    if (error) return <Typography color="error" sx={{ p: 2, mt: 8 }}>{error}</Typography>;

    return (
        <Container maxWidth="md" sx={{ py: 2, mt: 8 }} className="post-feed-container">
            {/* Create Post Component */}
            <Paper 
                elevation={1} 
                sx={{ 
                    mb: 3, 
                    p: 2, 
                    borderRadius: 2,
                    border: '1px solid #eaeaea'
                }}
                className="create-post-container"
            >
                <Box sx={{ display: 'flex', gap: 2 }}>
                    {currentUser && (
                        <Avatar 
                            sx={{ 
                                bgcolor: getAvatarColor(currentUser.profilePicture),
                            }}
                        >
                            {currentUser.username.charAt(0).toUpperCase()}
                        </Avatar>
                    )}
                    <Box sx={{ flex: 1 }}>
                        <TextField
                            fullWidth
                            multiline
                            variant="standard"
                            placeholder="What's happening?"
                            value={postContent}
                            onChange={(e) => setPostContent(e.target.value)}
                            InputProps={{
                                disableUnderline: true,
                                className: "create-post-input"
                            }}
                            sx={{ 
                                '& .MuiInputBase-root': { 
                                    fontSize: '1.1rem',
                                    p: 1
                                }
                            }}
                        />
                        
                        {tags.length > 0 && (
                            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 1, mb: 1 }}>
                                {tags.map((tag, index) => (
                                    <Typography 
                                        key={index} 
                                        color="primary" 
                                        variant="body2"
                                        sx={{ fontWeight: 'bold' }}
                                        className="hashtag"
                                    >
                                        #{tag}
                                    </Typography>
                                ))}
                            </Box>
                        )}
                        
                        <Box sx={{ 
                            display: 'flex', 
                            justifyContent: 'space-between', 
                            alignItems: 'center',
                            mt: 2 
                        }}>
                            <Box sx={{ display: 'flex', gap: 1 }}>
                                <IconButton 
                                    color="primary" 
                                    size="small"
                                    onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                                >
                                    <EmojiEmotionsIcon fontSize="small" />
                                </IconButton>
                                <IconButton color="primary" size="small">
                                    <ImageIcon fontSize="small" />
                                </IconButton>
                                {showEmojiPicker && (
                                    <Box sx={{ 
                                        position: 'absolute', 
                                        zIndex: 1000,
                                        mt: 2,
                                        transform: 'translateY(0)'
                                    }}
                                    className="emoji-picker-container"
                                    >
                                        <EmojiPicker onEmojiClick={onEmojiClick} />
                                    </Box>
                                )}
                            </Box>
                            <Button 
                                variant="contained" 
                                color="primary" 
                                size="small"
                                disabled={!postContent.trim() || isSubmitting}
                                onClick={handleCreatePost}
                                endIcon={isSubmitting ? <CircularProgress size={16} /> : <SendIcon />}
                                sx={{ 
                                    borderRadius: 5,
                                    px: 2
                                }}
                            >
                                Post
                            </Button>
                        </Box>
                    </Box>
                </Box>
            </Paper>
            
            <Divider sx={{ mb: 3 }} />
            
            {/* Posts Feed */}
            {postsLoading ? (
                // Show skeleton loaders while posts are loading
                Array.from(new Array(3)).map((_, index) => (
                    <Paper 
                        key={index} 
                        sx={{ 
                            mb: 3, 
                            p: 2, 
                            borderRadius: 2,
                            border: '1px solid #eaeaea'
                        }}
                    >
                        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
                            <Skeleton variant="circular" width={40} height={40} />
                            <Box sx={{ flex: 1 }}>
                                <Skeleton variant="text" width="40%" height={24} sx={{ mb: 1 }} />
                                <Skeleton variant="text" width="20%" height={16} sx={{ mb: 2 }} />
                                <Skeleton variant="text" width="100%" height={20} sx={{ mb: 1 }} />
                                <Skeleton variant="text" width="100%" height={20} sx={{ mb: 1 }} />
                                <Skeleton variant="text" width="80%" height={20} sx={{ mb: 2 }} />
                                <Box sx={{ display: 'flex', gap: 2 }}>
                                    <Skeleton variant="text" width={60} height={24} />
                                    <Skeleton variant="text" width={60} height={24} />
                                </Box>
                            </Box>
                        </Box>
                    </Paper>
                ))
            ) : posts.length === 0 ? (
                <Typography variant="body1" sx={{ textAlign: 'center', py: 4 }}>
                    No posts yet!
                </Typography>
            ) : (
                posts.map(post => (
                    <Paper 
                        key={post._id} 
                        sx={{ 
                            mb: 3, 
                            p: 2, 
                            borderRadius: 2,
                            border: '1px solid #eaeaea'
                        }}
                        className="post-card"
                        onClick={() => navigate(`/thread/${post._id}`)}
                    >
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
                                            onClick={(e) => {
                                                e.stopPropagation(); // Prevent navigation
                                                handleMenuOpen(e, post._id);
                                            }}
                                            aria-label="post options"
                                            id="post-options-button"
                                        >
                                            <MoreVert />
                                        </IconButton>
                                    )}
                                </Box>
                                
                                <Typography 
                                    variant="body1" 
                                    className="post-content"
                                    sx={{ 
                                        mb: 2,
                                        textAlign: 'left'
                                    }}
                                >
                                    {post.content.split(/(#\w+)/g).map((part, index) => {
                                        if (part.startsWith('#')) {
                                            return (
                                                <Typography
                                                    key={index}
                                                    component="span"
                                                    color="primary"
                                                    sx={{ fontWeight: 'bold' }}
                                                    onClick={(e) => {
                                                        e.stopPropagation(); // Prevent navigation
                                                        const tag = part.substring(1);
                                                        navigate(`/feed?tags=${tag}`);
                                                    }}
                                                    className="hashtag"
                                                >
                                                    {part}
                                                </Typography>
                                            );
                                        }
                                        return part;
                                    })}
                                </Typography>
                                
                                <Box sx={{ display: 'flex', gap: 3, alignItems: 'center' }} className="post-actions">
                                    <Box 
                                        sx={{ display: 'flex', alignItems: 'center', gap: 1 }}
                                        className={`action-button like-button ${likedPosts[post._id] ? 'active' : ''}`}
                                        onClick={(e) => {
                                            e.stopPropagation(); // Prevent navigation
                                            handleLike(post._id);
                                        }}
                                    >
                                        <IconButton 
                                            size="small" 
                                            color="inherit"
                                        >
                                            {likedPosts[post._id] ? <Favorite /> : <FavoriteBorder />}
                                        </IconButton>
                                        <Typography variant="body2">
                                            {post.likes || 0}
                                        </Typography>
                                    </Box>
                                    <Box 
                                        sx={{ display: 'flex', alignItems: 'center', gap: 1 }}
                                        className="action-button"
                                        onClick={(e) => {
                                            e.stopPropagation(); // Prevent navigation
                                            navigate(`/thread/${post._id}`);
                                        }}
                                    >
                                        <IconButton 
                                            size="small"
                                            color="inherit"
                                        >
                                            <ChatBubbleOutline />
                                        </IconButton>
                                        <Typography variant="body2">
                                            {post.comments ? post.comments.length : 0}
                                        </Typography>
                                    </Box>
                                </Box>
                            </Box>
                        </Box>
                    </Paper>
                ))
            )}
            
            {/* Post Options Menu */}
            <Menu
                id="post-menu"
                anchorEl={menuAnchorEl}
                open={Boolean(menuAnchorEl)}
                onClose={handleMenuClose}
            >
                <MenuItem onClick={handleDeletePost}>Delete</MenuItem>
            </Menu>
        </Container>
    );
};

export default PostFeed;
