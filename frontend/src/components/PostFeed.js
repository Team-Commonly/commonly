/* eslint-disable max-len */
import React, { useEffect, useState, useCallback } from 'react';
import axios from 'axios';
import { useOutletContext, useNavigate } from 'react-router-dom';
import { 
    Typography, Avatar, Box, Button, Container, IconButton, Menu, MenuItem, 
    Paper, TextField, Divider, CircularProgress, Skeleton
} from '@mui/material';
import { formatDistanceToNow } from 'date-fns';
import { 
    ChatBubbleOutline, 
    FavoriteBorder, 
    Favorite, 
    MoreVert,
    EmojiEmotions as EmojiEmotionsIcon,
    Image as ImageIcon,
    Send as SendIcon,
    Close as CloseIcon
} from '@mui/icons-material';
import { getAvatarColor } from '../utils/avatarUtils';
import { useAppContext } from '../context/AppContext';
import { blurActiveElement } from '../utils/focusUtils';
import EmojiPicker from 'emoji-picker-react';
import './PostFeed.css'; // Import the CSS file

const PostFeed = () => {
    const { 
        currentUser, 
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
    const [selectedImage, setSelectedImage] = useState(null);
    const [imagePreview, setImagePreview] = useState(null);
    const fileInputRef = React.useRef(null);
    const emojiButtonRef = React.useRef(null);
    
    // Extract hashtags from content
    useEffect(() => {
        const extractedTags = postContent.match(/#[\w]+/g) || [];
        setTags(extractedTags.map(tag => tag.slice(1))); // Remove # from tags
    }, [postContent]);
    
    // Handle clicking outside emoji picker
    useEffect(() => {
        const handleClickOutside = (event) => {
            if (showEmojiPicker && 
                emojiButtonRef.current && 
                !emojiButtonRef.current.contains(event.target) &&
                !event.target.closest('.emoji-picker-portal')) {
                setShowEmojiPicker(false);
            }
        };

        if (showEmojiPicker) {
            document.addEventListener('mousedown', handleClickOutside);
            document.addEventListener('touchstart', handleClickOutside);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('touchstart', handleClickOutside);
        };
    }, [showEmojiPicker]);
    
    const handleCreatePost = async (e) => {
        e.preventDefault();
        if (!postContent.trim() && !selectedImage) return;
        
        setIsSubmitting(true);
        try {
            let postData;
            let imageUrl = null;
            
            // If there's an image, upload it first
            if (selectedImage) {
                const imageFormData = new FormData();
                imageFormData.append('image', selectedImage);
                
                // Upload the image
                const imageResponse = await axios.post('/api/uploads', imageFormData, {
                    headers: { 
                        Authorization: `Bearer ${localStorage.getItem('token')}`,
                        'Content-Type': 'multipart/form-data'
                    }
                });
                
                // Get the image URL from the response - this is now an API URL
                imageUrl = imageResponse.data.url;
            }
            
            // Create post with the uploaded image URL if available
            postData = {
                content: postContent.trim() || "Posted an image", // Default content if only image
                tags: tags
            };
            
            if (imageUrl) {
                postData.image = imageUrl;
            }
            
            // Create the post
            await axios.post('/api/posts', postData, {
                headers: { 
                    Authorization: `Bearer ${localStorage.getItem('token')}`
                }
            });
            
            // Clear the form
            setPostContent('');
            setTags([]);
            setSelectedImage(null);
            setImagePreview(null);
            
            // Refresh data to ensure consistency
            window.location.reload();
        } catch (err) {
            setError('Failed to create post. Please try again later.');
            console.error('Error creating post:', err);
        } finally {
            setIsSubmitting(false);
        }
    };
    
    const onEmojiClick = (emojiData) => {
        setPostContent(prevContent => prevContent + emojiData.emoji);
    };
    
    const handleImageUpload = (e) => {
        const file = e.target.files[0];
        if (file) {
            setSelectedImage(file);
            const reader = new FileReader();
            reader.onloadend = () => {
                setImagePreview(reader.result);
            };
            reader.readAsDataURL(file);
        }
    };
    
    const handleRemoveImage = () => {
        setSelectedImage(null);
        setImagePreview(null);
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
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

    // Add a function to refresh the page after a delay
    const refreshPage = (delay = 0) => {
        setTimeout(() => {
            window.location.reload();
        }, delay);
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
    const fetchPosts = useCallback(async () => {
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
    }, [currentUser, setContextPosts]);

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
    }, [searchResults, currentUser, setContextPosts, fetchPosts]);

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
                            mt: 2,
                            position: 'relative'
                        }}>
                            <Box sx={{ display: 'flex', gap: 1, position: 'relative' }}>
                                <IconButton 
                                    ref={emojiButtonRef}
                                    color="primary" 
                                    size="small"
                                    onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                                    className="emoji-button"
                                    data-testid="emoji-button"
                                >
                                    <EmojiEmotionsIcon fontSize="small" />
                                </IconButton>
                                <IconButton 
                                    component="label"
                                    color="primary" 
                                    size="small"
                                    aria-label="Attach image"
                                >
                                    <input
                                        type="file"
                                        accept="image/*"
                                        onChange={handleImageUpload}
                                        ref={fileInputRef}
                                        style={{ display: 'none' }}
                                    />
                                    <ImageIcon fontSize="small" />
                                </IconButton>
                            </Box>
                            <Button 
                                variant="contained" 
                                color="primary" 
                                size="small"
                                disabled={(!postContent.trim() && !selectedImage) || isSubmitting}
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
                        
                        {imagePreview && (
                            <Box sx={{ mt: 2, position: 'relative' }}>
                                <Box
                                    component="img"
                                    src={imagePreview}
                                    alt="Selected"
                                    sx={{
                                        width: '100%',
                                        maxHeight: '300px',
                                        objectFit: 'contain',
                                        borderRadius: '8px',
                                    }}
                                />
                                <IconButton
                                    sx={{
                                        position: 'absolute',
                                        top: 8,
                                        right: 8,
                                        backgroundColor: 'rgba(0,0,0,0.5)',
                                        color: 'white',
                                        '&:hover': {
                                            backgroundColor: 'rgba(0,0,0,0.7)',
                                        },
                                        padding: '4px',
                                    }}
                                    onClick={handleRemoveImage}
                                >
                                    <CloseIcon fontSize="small" />
                                </IconButton>
                            </Box>
                        )}
                    </Box>
                </Box>
            </Paper>
            
            {/* Emoji Picker Portal - Positioned outside the post container */}
            {showEmojiPicker && (
                <Box 
                    className="emoji-picker-portal"
                    sx={{ 
                        position: 'fixed', 
                        zIndex: 1300,
                        top: (() => {
                            if (emojiButtonRef.current) {
                                const rect = emojiButtonRef.current.getBoundingClientRect();
                                return rect && typeof rect.bottom === 'number' ? rect.bottom + 5 : '50%';
                            }
                            return '50%';
                        })(),
                        left: (() => {
                            if (emojiButtonRef.current) {
                                const rect = emojiButtonRef.current.getBoundingClientRect();
                                return rect && typeof rect.left === 'number' ? rect.left : '50%';
                            }
                            return '50%';
                        })(),
                        transform: (() => {
                            if (emojiButtonRef.current) {
                                const rect = emojiButtonRef.current.getBoundingClientRect();
                                return rect && typeof rect.bottom === 'number' ? 'none' : 'translate(-50%, -50%)';
                            }
                            return 'translate(-50%, -50%)';
                        })()
                    }}
                    onClick={(e) => e.stopPropagation()}
                >
                    <Box 
                        className="emoji-picker-container"
                        sx={{
                            backgroundColor: '#fff',
                            borderRadius: '12px',
                            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.15)',
                            border: '1px solid #e1e8ed',
                            overflow: 'hidden'
                        }}
                    >
                        <EmojiPicker 
                            onEmojiClick={onEmojiClick} 
                            width={320}
                            height={380}
                            emojiStyle="native"
                            searchDisabled={false}
                            skinTonesDisabled={true}
                            previewConfig={{ showPreview: false }}
                            style={{ transform: 'none', scale: 1 }}
                        />
                    </Box>
                </Box>
            )}
            
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
                                                        refreshData(); // Refresh data before navigation
                                                        window.location.href = `/feed?q=${tag}`;
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
                                
                                {post.image && (
                                    <Box 
                                        sx={{ 
                                            mt: 1, 
                                            mb: 2, 
                                            borderRadius: '8px',
                                            overflow: 'hidden',
                                            maxHeight: '400px',
                                        }}
                                        className="post-image-container"
                                    >
                                        <Box
                                            component="img"
                                            src={post.image}
                                            alt="Post image"
                                            sx={{
                                                width: '100%',
                                                maxHeight: '400px',
                                                objectFit: 'contain',
                                                borderRadius: '8px',
                                                backgroundColor: '#f8f9fa'
                                            }}
                                            className="post-image"
                                        />
                                    </Box>
                                )}
                                
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
