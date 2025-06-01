/* eslint-disable max-len */
import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, CardContent, Typography, Avatar, Box, Divider, Paper, Button, IconButton, Menu, MenuItem, CircularProgress } from '@mui/material';
import { formatDistanceToNow } from 'date-fns';
import EmojiEmotionsIcon from '@mui/icons-material/EmojiEmotions';
import FavoriteBorderIcon from '@mui/icons-material/FavoriteBorder';
import FavoriteIcon from '@mui/icons-material/Favorite';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import EmojiPicker from 'emoji-picker-react';
import { getAvatarColor } from '../utils/avatarUtils';
import { useAppContext } from '../context/AppContext';
import { blurActiveElement } from '../utils/focusUtils';
import { refreshPage } from '../utils/refreshUtils';
import './Thread.css';
import '../components/PostFeed.css';

const Thread = () => {
    const { id } = useParams();
    const navigate = useNavigate();
    const { currentUser, refreshData, removePost } = useAppContext();
    const [post, setPost] = useState(null);
    const [error, setError] = useState('');
    const [comment, setComment] = useState('');
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);
    const [liked, setLiked] = useState(false);
    const [menuAnchorEl, setMenuAnchorEl] = useState(null);
    const [selectedItemId, setSelectedItemId] = useState(null);
    const [itemType, setItemType] = useState(null); // 'post' or 'comment'
    const [loading, setLoading] = useState(true);
    const emojiButtonRef = React.useRef(null);

    useEffect(() => {
        const fetchPost = async () => {
            setLoading(true);
            try {
                const res = await axios.get(`/api/posts/${id}`);
                setPost(res.data);
                
                // Check if current user has liked this post
                if (currentUser && res.data.likedBy) {
                    // Check if likedBy contains the current user's ID
                    const isLiked = res.data.likedBy.some(user => 
                        user._id === currentUser._id || user === currentUser._id
                    );
                    setLiked(isLiked);
                } else {
                    setLiked(false);
                }
            } catch (err) {
                setError('Failed to fetch post. Please try again later.');
            } finally {
                setLoading(false);
            }
        };
        fetchPost();
    }, [id, currentUser]);

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
            
            // Refresh data to ensure consistency
            refreshData();
        } catch (err) {
            setError('Failed to post comment. Please try again.');
        }
    };

    const handleLike = async () => {
        // Store current liked state
        const wasLiked = liked;
        
        try {
            // Update UI immediately for better user experience
            setLiked(!wasLiked);
            
            // Send request to server
            const response = await axios.post(`/api/posts/${id}/like`, {}, {
                headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
            });
            
            // Update post likes count
            setPost(prevPost => ({
                ...prevPost,
                likes: response.data.likes
            }));
            
            // If server response doesn't match our optimistic update, correct it
            if (response.data.liked !== !wasLiked) {
                setLiked(response.data.liked);
            }
        } catch (err) {
            console.error('Failed to like post:', err);
            // Revert UI change if request fails
            setLiked(wasLiked);
        }
    };

    const handleMenuOpen = (event, itemId, type) => {
        event.stopPropagation();
        setMenuAnchorEl(event.currentTarget);
        setSelectedItemId(itemId);
        setItemType(type);
    };

    const handleMenuClose = () => {
        setMenuAnchorEl(null);
        setSelectedItemId(null);
        setItemType(null);
        blurActiveElement();
    };

    const handleDelete = async () => {
        if (!selectedItemId) return;
        
        try {
            // Close the menu first
            handleMenuClose();
            
            if (itemType === 'post') {
                // Use the removePost function from context
                removePost(selectedItemId);
                
                // Navigate back to feed immediately
                navigate('/feed');
                
                // Send the delete request to the server
                await axios.delete(`/api/posts/${selectedItemId}`, {
                    headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
                });
                
                // Trigger a page refresh after a short delay
                refreshPage(500);
            } else if (itemType === 'comment') {
                // Remove the deleted comment from the state immediately
                setPost(prevPost => ({
                    ...prevPost,
                    comments: prevPost.comments.filter(comment => comment._id !== selectedItemId)
                }));
                
                // Send the delete request to the server
                await axios.delete(`/api/posts/${id}/comments/${selectedItemId}`, {
                    headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
                });
                
                // No refresh needed for comment deletion as we've already updated the state
            }
        } catch (err) {
            console.error(`Failed to delete ${itemType}:`, err);
            // If there's an error, revert the UI changes by refreshing the data
            refreshData();
        }
    };

    const onEmojiClick = (emojiObj) => {
        // Support both older and newer emoji-picker-react versions
        const emoji = emojiObj.emoji || (emojiObj.unified && String.fromCodePoint(parseInt(emojiObj.unified, 16)));
        if (emoji) {
            setComment(prevComment => prevComment + emoji);
        }
    };

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

    if (error) return <Typography color="error" sx={{ p: 2 }}>{error}</Typography>;
    if (loading) return (
        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
            <CircularProgress />
        </Box>
    );
    if (!post) return <Typography sx={{ p: 2 }}>Post not found</Typography>;

    return (
        <Box sx={{ maxWidth: 800, mx: 'auto', p: 3, mt: 8 }}>
            <Card sx={{ mb: 4 }}>
                <CardContent>
                    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
                        <Box sx={{ display: 'flex', alignItems: 'center' }}>
                            <Avatar sx={{ 
                                bgcolor: getAvatarColor(post.userId.profilePicture), 
                                mr: 2 
                            }}>
                                {post.userId.username.charAt(0).toUpperCase()}
                            </Avatar>
                            <Box>
                                <Typography variant="h6">{post.userId.username}</Typography>
                                <Typography variant="caption" color="text.secondary">
                                    {formatDistanceToNow(new Date(post.createdAt))} ago
                                </Typography>
                            </Box>
                        </Box>
                        {currentUser && (currentUser._id === post.userId._id) && (
                            <IconButton 
                                size="small" 
                                onClick={(e) => handleMenuOpen(e, post._id, 'post')}
                                aria-label="post options"
                                id="post-options-button"
                            >
                                <MoreVertIcon />
                            </IconButton>
                        )}
                    </Box>
                    <Typography variant="body1" sx={{ mt: 2, mb: 2, textAlign: 'left' }}>
                        {post.content.split(/(#\w+)/g).map((part, index) => {
                            if (part.startsWith('#')) {
                                return (
                                    <Typography
                                        key={index}
                                        component="span"
                                        color="primary"
                                        sx={{ fontWeight: 'bold' }}
                                        onClick={() => navigate(`/feed?q=${part.substring(1)}`)}
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
                                mb: 3, 
                                borderRadius: '8px',
                                overflow: 'hidden',
                                maxHeight: '500px',
                            }}
                            className="post-image-container"
                        >
                            <Box
                                component="img"
                                src={post.image}
                                alt="Post image"
                                sx={{
                                    width: '100%',
                                    maxHeight: '500px',
                                    objectFit: 'contain',
                                    borderRadius: '8px',
                                    backgroundColor: '#f8f9fa'
                                }}
                                className="post-image"
                            />
                        </Box>
                    )}
                    
                    <Box sx={{ display: 'flex', alignItems: 'center', mt: 2 }}>
                        <IconButton onClick={handleLike} color="primary">
                            {liked ? <FavoriteIcon /> : <FavoriteBorderIcon />}
                        </IconButton>
                        <Typography variant="body2" color="text.secondary">
                            {post.likes || 0} likes
                        </Typography>
                    </Box>
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
                            ref={emojiButtonRef}
                            className="emoji-button"
                            onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                            color="primary"
                            data-testid="emoji-button"
                        >
                            <EmojiEmotionsIcon />
                        </IconButton>
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

            {/* Emoji Picker Portal - Positioned outside the comment form container */}
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

            <Typography variant="h6" sx={{ mb: 2 }}>
                Comments ({post.comments.length})
            </Typography>

            {post.comments.map((comment) => (
                <Paper key={comment._id} sx={{ p: 2, mb: 2 }}>
                    <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                            <Avatar sx={{ 
                                width: 32, 
                                height: 32, 
                                mr: 1, 
                                bgcolor: getAvatarColor(comment.userId && comment.userId.profilePicture) 
                            }}>
                                {comment.userId && comment.userId.username ? comment.userId.username.charAt(0).toUpperCase() : '?'}
                            </Avatar>
                            <Box>
                                <Typography variant="subtitle2">{comment.userId && comment.userId.username ? comment.userId.username : 'Unknown User'}</Typography>
                                <Typography variant="caption" color="text.secondary">
                                    {formatDistanceToNow(new Date(comment.createdAt))} ago
                                </Typography>
                            </Box>
                        </Box>
                        {currentUser && comment.userId && (currentUser._id === comment.userId._id) && (
                            <IconButton 
                                size="small" 
                                onClick={(e) => handleMenuOpen(e, comment._id, 'comment')}
                                aria-label="comment options"
                                id="post-options-button"
                            >
                                <MoreVertIcon />
                            </IconButton>
                        )}
                    </Box>
                    <Typography variant="body2" sx={{ mt: 1, textAlign: 'left' }}>
                        {comment.text.split(/(#\w+)/g).map((part, index) => {
                            if (part.startsWith('#')) {
                                return (
                                    <Typography
                                        key={index}
                                        component="span"
                                        color="primary"
                                        sx={{ fontWeight: 'bold' }}
                                        onClick={() => navigate(`/feed?q=${part.substring(1)}`)}
                                        className="hashtag"
                                    >
                                        {part}
                                    </Typography>
                                );
                            }
                            return part;
                        })}
                    </Typography>
                </Paper>
            ))}

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
                    onClick={handleDelete}
                    tabIndex={0}
                >
                    Delete
                </MenuItem>
            </Menu>
        </Box>
    );
};

export default Thread;
