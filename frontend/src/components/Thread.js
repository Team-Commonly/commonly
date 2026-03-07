/* eslint-disable max-len */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { scrollToElementById } from '../utils/scrollUtils';
import axios from 'axios';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, CardContent, Typography, Avatar, Box, Divider, Paper, Button, IconButton, Menu, MenuItem, CircularProgress, Tooltip } from '@mui/material';
import { formatDistanceToNow } from 'date-fns';
import EmojiEmotionsIcon from '@mui/icons-material/EmojiEmotions';
import SendIcon from '@mui/icons-material/Send';
import ReplyIcon from '@mui/icons-material/Reply';
import CloseIcon from '@mui/icons-material/Close';
import FavoriteBorderIcon from '@mui/icons-material/FavoriteBorder';
import FavoriteIcon from '@mui/icons-material/Favorite';
import BookmarkBorderIcon from '@mui/icons-material/BookmarkBorder';
import BookmarkIcon from '@mui/icons-material/Bookmark';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import EmojiPicker from 'emoji-picker-react';
import { AgentAvatar } from './common/AgentIndicator';
import { getAvatarColor, getAvatarSrc } from '../utils/avatarUtils';
import { normalizeUploadUrl } from '../utils/apiBaseUrl';
import { useAppContext } from '../context/AppContext';
import { blurActiveElement } from '../utils/focusUtils';
import { refreshPage } from '../utils/refreshUtils';
import './Thread.css';
import '../components/PostFeed.css';

const normalizeAgentSegment = (value) => (
    (value || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40)
);

const buildAgentUsername = (agentName, instanceId) => {
    const normalized = normalizeAgentSegment(agentName);
    const instance = normalizeAgentSegment(instanceId);
    if (!instance || instance === 'default' || instance === normalized) {
        return normalized || 'agent';
    }
    return `${normalized}-${instance}`;
};

const slugify = (value = '') => value
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

const getUserDisplayName = (user) => {
    if (!user) return 'Unknown';
    if (user.isBot && user.botMetadata?.displayName) return user.botMetadata.displayName;
    return user.username || 'Unknown';
};

const Thread = () => {
    const { id } = useParams();
    const navigate = useNavigate();
    const { currentUser, refreshData, removePost } = useAppContext();
    const [post, setPost] = useState(null);
    const [error, setError] = useState('');
    const [comment, setComment] = useState('');
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);
    const [liked, setLiked] = useState(false);
    const [threadFollowed, setThreadFollowed] = useState(false);
    const [threadFollowLoading, setThreadFollowLoading] = useState(false);
    const [menuAnchorEl, setMenuAnchorEl] = useState(null);
    const [selectedItemId, setSelectedItemId] = useState(null);
    const [itemType, setItemType] = useState(null); // 'post' or 'comment'
    const [loading, setLoading] = useState(true);
    const [podAgents, setPodAgents] = useState([]);
    const [threadPodId, setThreadPodId] = useState(null);
    const [mentionOpen, setMentionOpen] = useState(false);
    const [mentionQuery, setMentionQuery] = useState('');
    const [mentionStart, setMentionStart] = useState(-1);
    const [mentionIndex, setMentionIndex] = useState(0);
    const [lightboxImage, setLightboxImage] = useState(null);
    const [lightboxAlt, setLightboxAlt] = useState('');
    const [lightboxZoomed, setLightboxZoomed] = useState(false);
    const [replyingTo, setReplyingTo] = useState(null);
    const emojiButtonRef = useRef(null);
    const commentInputRef = useRef(null);
    const mentionDropdownRef = useRef(null);

    const mentionableItems = useMemo(() => {
        const items = [];
        (podAgents || []).forEach((agent) => {
            const agentName = agent?.name;
            if (!agentName) return;
            const display = agent.profile?.displayName || agent.displayName || agent.name;
            const username = buildAgentUsername(agent.name, agent.instanceId);
            const displaySlug = slugify(display);
            const instanceId = agent.instanceId || 'default';
            const mentionValue = instanceId !== 'default'
                ? instanceId
                : (displaySlug || agent.name);
            const labelSearch = `${display} ${agent.name} ${username} ${mentionValue}`.toLowerCase();
            items.push({
                id: username,
                label: display,
                labelLower: labelSearch,
                subtitle: `Agent • @${mentionValue}`,
                avatar: agent?.profile?.iconUrl || agent?.profile?.avatarUrl || '',
                isAgent: true,
                value: mentionValue,
            });
        });
        return items;
    }, [podAgents]);

    const commentMap = useMemo(() => {
        if (!post?.comments) return {};
        return post.comments.reduce((acc, c) => {
            acc[c._id] = c;
            return acc;
        }, {});
    }, [post?.comments]);

    const filteredMentions = useMemo(() => {
        if (!mentionOpen) return [];
        const query = mentionQuery.trim().toLowerCase();
        const result = mentionableItems.filter((item) => item.labelLower.includes(query));
        return result.slice(0, 8);
    }, [mentionOpen, mentionQuery, mentionableItems]);

    const scrollHighlightTimer = useRef(null);
    const scrollToComment = (commentId) => {
        clearTimeout(scrollHighlightTimer.current);
        scrollHighlightTimer.current = scrollToElementById(`comment-${commentId}`, 'comment-highlight');
    };

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

    useEffect(() => {
        const fetchFollowState = async () => {
            if (!currentUser || !id) return;
            try {
                const response = await axios.get('/api/posts/following/threads', {
                    headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
                });
                const threads = response.data?.threads || [];
                setThreadFollowed(threads.some((thread) => thread._id === id));
            } catch (err) {
                // Keep default state if endpoint fails
            }
        };
        fetchFollowState();
    }, [currentUser, id]);

    useEffect(() => {
        const fetchThreadAgents = async () => {
            if (!currentUser || !post) return;
            const token = localStorage.getItem('token');
            if (!token) return;
            const authHeaders = {
                headers: { Authorization: `Bearer ${token}` }
            };

            try {
                const postPodId = typeof post?.podId === 'object' ? post.podId?._id : post?.podId;
                let resolvedPodId = postPodId || null;
                if (!resolvedPodId) {
                    const podsRes = await axios.get('/api/pods', authHeaders);
                    const pods = Array.isArray(podsRes.data) ? podsRes.data : podsRes.data?.pods || [];
                    resolvedPodId = pods[0]?._id || null;
                }

                setThreadPodId(resolvedPodId);

                if (!resolvedPodId) {
                    setPodAgents([]);
                    return;
                }

                const agentsRes = await axios.get(`/api/registry/pods/${resolvedPodId}/agents`, authHeaders);
                setPodAgents(agentsRes.data?.agents || []);
            } catch (err) {
                console.warn('Failed to fetch thread agents:', err.response?.status);
            }
        };

        fetchThreadAgents();
    }, [post, currentUser]);

    const openLightbox = (src, alt = '') => {
        setLightboxImage(src);
        setLightboxAlt(alt);
        setLightboxZoomed(false);
    };

    const closeLightbox = () => {
        setLightboxImage(null);
        setLightboxAlt('');
        setLightboxZoomed(false);
    };

    const handleCommentSubmit = async (e) => {
        e.preventDefault();
        if (!comment.trim()) return;
    
        try {
            const payload = {
                text: comment,
                ...(threadPodId ? { podId: threadPodId } : {}),
                ...(replyingTo ? { replyToCommentId: replyingTo._id } : {}),
            };
            const res = await axios.post(`/api/posts/${id}/comments`,
                payload,
                { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } }
            );
            setPost(prevPost => ({
                ...prevPost,
                comments: [...prevPost.comments, res.data]
            }));
            setComment('');
            setShowEmojiPicker(false);
            setMentionOpen(false);
            setMentionQuery('');
            setMentionStart(-1);
            setReplyingTo(null);
            
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

    const handleToggleThreadFollow = async () => {
        if (!id || threadFollowLoading) return;
        setThreadFollowLoading(true);
        try {
            if (threadFollowed) {
                await axios.delete(`/api/posts/${id}/follow`, {
                    headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
                });
                setThreadFollowed(false);
            } else {
                await axios.post(`/api/posts/${id}/follow`, {}, {
                    headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
                });
                setThreadFollowed(true);
            }
        } catch (err) {
            setError('Failed to update thread follow. Please try again.');
        } finally {
            setThreadFollowLoading(false);
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

    const getMentionContext = (text, cursor) => {
        if (!text || cursor === null || cursor === undefined) return null;
        const atIndex = text.lastIndexOf('@', cursor - 1);
        if (atIndex < 0) return null;
        const beforeChar = text[atIndex - 1];
        if (beforeChar && !/\s|[([{"'`]/.test(beforeChar)) return null;
        const between = text.slice(atIndex + 1, cursor);
        if (/\s/.test(between)) return null;
        return { start: atIndex, query: between };
    };

    const updateMentionState = (nextValue, cursorPosition) => {
        const context = getMentionContext(nextValue, cursorPosition);
        if (!context) {
            setMentionOpen(false);
            setMentionQuery('');
            setMentionStart(-1);
            return;
        }
        setMentionOpen(true);
        setMentionQuery(context.query);
        setMentionStart(context.start);
        setMentionIndex(0);
    };

    const handleMentionSelect = (item) => {
        const input = commentInputRef.current;
        if (!input) return;
        const cursor = input.selectionStart ?? comment.length;
        const start = mentionStart >= 0 ? mentionStart : comment.lastIndexOf('@', cursor);
        if (start < 0) return;
        const insert = `@${item.value || item.label}`;
        const nextValue = `${comment.slice(0, start)}${insert} ${comment.slice(cursor)}`;
        setComment(nextValue);
        setMentionOpen(false);
        setMentionQuery('');
        setMentionStart(-1);
        requestAnimationFrame(() => {
            const nextCursor = start + insert.length + 1;
            input.focus();
            input.setSelectionRange(nextCursor, nextCursor);
        });
    };

    const handleCommentKeyDown = (event) => {
        if (mentionOpen && filteredMentions.length > 0) {
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                setMentionIndex((prev) => (prev + 1) % filteredMentions.length);
                return;
            }
            if (event.key === 'ArrowUp') {
                event.preventDefault();
                setMentionIndex((prev) => (prev - 1 + filteredMentions.length) % filteredMentions.length);
                return;
            }
            if (event.key === 'Escape') {
                event.preventDefault();
                setMentionOpen(false);
                return;
            }
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                const selected = filteredMentions[mentionIndex];
                if (selected) {
                    handleMentionSelect(selected);
                }
                return;
            }
        }
        if (event.key !== 'Enter') {
            return;
        }
        if (event.shiftKey) {
            event.stopPropagation();
            return;
        }
        event.preventDefault();
        handleCommentSubmit(event);
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

    useEffect(() => {
        const handleMentionClickOutside = (event) => {
            if (!mentionOpen) return;
            if (mentionDropdownRef.current && mentionDropdownRef.current.contains(event.target)) return;
            if (commentInputRef.current && commentInputRef.current.contains(event.target)) return;
            setMentionOpen(false);
        };

        document.addEventListener('mousedown', handleMentionClickOutside);
        return () => {
            document.removeEventListener('mousedown', handleMentionClickOutside);
        };
    }, [mentionOpen]);

    if (error) return <Typography color="error" sx={{ p: 2 }}>{error}</Typography>;
    if (loading) return (
        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
            <CircularProgress />
        </Box>
    );
    if (!post) return <Typography sx={{ p: 2 }}>Post not found</Typography>;

    return (
        <Box
            className="thread-wrapper"
            sx={{
                maxWidth: 800,
                mx: 'auto',
                px: { xs: 0, sm: 3 },
                pt: { xs: 2, sm: 3 },
                pb: { xs: 10, sm: 6 },
                mt: { xs: 2, sm: 4 }
            }}
        >
            {lightboxImage && (
                <div className="image-lightbox" onClick={closeLightbox} role="presentation">
                    <img
                        src={normalizeUploadUrl(lightboxImage)}
                        alt={lightboxAlt || 'Post'}
                        className={`image-lightbox-img ${lightboxZoomed ? 'zoomed' : ''}`}
                        onClick={(event) => {
                            event.stopPropagation();
                            setLightboxZoomed((prev) => !prev);
                        }}
                    />
                </div>
            )}
            <Card sx={{ mb: 4 }}>
                <CardContent>
                    <div className="post-header">
                        <div className="post-meta">
                            {post.userId.isBot ? (
                                <AgentAvatar
                                    className="post-avatar"
                                    username={post.userId.username}
                                    size={40}
                                    showBadge={false}
                                />
                            ) : (
                                <Avatar
                                    className="post-avatar"
                                    sx={{ bgcolor: getAvatarColor(post.userId.profilePicture) }}
                                    src={getAvatarSrc(post.userId.profilePicture)}
                                >
                                    {post.userId.username.charAt(0).toUpperCase()}
                                </Avatar>
                            )}
                            <div className="post-meta-text">
                                <Typography variant="h6">{getUserDisplayName(post.userId)}</Typography>
                                <Typography variant="caption" color="text.secondary">
                                    {formatDistanceToNow(new Date(post.createdAt))} ago
                                </Typography>
                            </div>
                        </div>
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
                    </div>
                    <div className="post-body">
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
                                onClick={() => openLightbox(normalizeUploadUrl(post.image), post.content)}
                            >
                                <Box
                                    component="img"
                                    src={normalizeUploadUrl(post.image)}
                                    alt="Post image"
                                    sx={{
                                        width: '100%',
                                        maxHeight: '500px',
                                        objectFit: 'contain',
                                        borderRadius: '8px',
                                        backgroundColor: 'rgba(15, 23, 42, 0.6)'
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
                            <Button
                                size="small"
                                sx={{ ml: 2 }}
                                startIcon={threadFollowed ? <BookmarkIcon /> : <BookmarkBorderIcon />}
                                onClick={handleToggleThreadFollow}
                                disabled={threadFollowLoading}
                            >
                                {threadFollowed ? 'Following Thread' : 'Follow Thread'}
                            </Button>
                        </Box>
                    </div>
                </CardContent>
            </Card>

            <Divider sx={{ mb: 3 }} />

            <div className="thread-comment-form">
                <form onSubmit={handleCommentSubmit} className="comment-composer">
                    {replyingTo && (
                        <div className="comment-reply-preview">
                            <ReplyIcon className="comment-reply-preview-icon" fontSize="small" />
                            <div className="comment-reply-preview-content">
                                <span className="comment-reply-preview-author">
                                    @{getUserDisplayName(replyingTo.userId)}
                                </span>
                                <span className="comment-reply-preview-text">
                                    {(replyingTo.text || '').slice(0, 80)}
                                </span>
                            </div>
                            <IconButton size="small" onClick={() => setReplyingTo(null)} aria-label="cancel reply">
                                <CloseIcon fontSize="small" />
                            </IconButton>
                        </div>
                    )}
                    {mentionOpen && filteredMentions.length > 0 && (
                        <div className="mention-dropdown" ref={mentionDropdownRef}>
                            {filteredMentions.map((item, index) => (
                                <button
                                    type="button"
                                    key={item.id}
                                    className={`mention-item ${index === mentionIndex ? 'active' : ''}`}
                                    onMouseDown={(event) => event.preventDefault()}
                                    onClick={() => handleMentionSelect(item)}
                                >
                                    <AgentAvatar
                                        username={item.value || item.label}
                                        src={item.avatar}
                                        size={28}
                                        showBadge={true}
                                    />
                                    <div className="mention-item-text">
                                        <span className="mention-item-label">@{item.label}</span>
                                        <span className="mention-item-subtitle">{item.subtitle}</span>
                                    </div>
                                </button>
                            ))}
                        </div>
                    )}
                    <div className="comment-composer-row">
                        <div className="comment-tools">
                            <Tooltip title="Emoji" placement="top">
                                <IconButton
                                    ref={emojiButtonRef}
                                    className={`emoji-button ${showEmojiPicker ? 'active' : ''}`}
                                    onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                                    color="primary"
                                    data-testid="emoji-button"
                                    aria-label="Insert emoji"
                                >
                                    <EmojiEmotionsIcon />
                                </IconButton>
                            </Tooltip>
                        </div>
                        <textarea
                            className="comment-textarea"
                            value={comment}
                            onChange={(e) => {
                                const nextValue = e.target.value;
                                setComment(nextValue);
                                updateMentionState(nextValue, e.target.selectionStart);
                            }}
                            onKeyDown={handleCommentKeyDown}
                            onClick={(e) => updateMentionState(e.target.value, e.target.selectionStart)}
                            onKeyUp={(e) => updateMentionState(e.target.value, e.target.selectionStart)}
                            placeholder={replyingTo ? `Reply to @${getUserDisplayName(replyingTo.userId)}...` : 'Write a comment...'}
                            ref={commentInputRef}
                        />
                        <Button
                            type="submit"
                            variant="contained"
                            color="primary"
                            disabled={!comment.trim()}
                            className="comment-send-button"
                            endIcon={<SendIcon />}
                        >
                            Post
                        </Button>
                    </div>
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
                            backgroundColor: 'rgba(15, 23, 42, 0.98)',
                            borderRadius: '12px',
                            boxShadow: '0 12px 32px rgba(8, 12, 24, 0.45)',
                            border: '1px solid rgba(148, 163, 184, 0.2)',
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

            {post.comments.map((comment) => {
                const quotedComment = comment.replyTo ? commentMap[comment.replyTo] : null;
                return (
                <Paper key={comment._id} id={`comment-${comment._id}`} className="comment-item">
                    {quotedComment && (
                        <div
                            className="comment-quote-bubble"
                            role="button"
                            onClick={() => scrollToComment(quotedComment._id)}
                        >
                            <div className="comment-quote-border" />
                            <div className="comment-quote-body">
                                <div className="comment-quote-author">
                                    {getUserDisplayName(quotedComment.userId)}
                                </div>
                                <div className="comment-quote-text">
                                    {(quotedComment.text || '').slice(0, 120)}
                                </div>
                            </div>
                        </div>
                    )}
                    <div className="comment-row">
                        {comment.userId?.isBot ? (
                            <AgentAvatar
                                className="comment-avatar"
                                username={comment.userId.username}
                                size={32}
                                showBadge={false}
                            />
                        ) : (
                            <Avatar
                                className="comment-avatar"
                                sx={{
                                    bgcolor: getAvatarColor(comment.userId && comment.userId.profilePicture)
                                }}
                                src={getAvatarSrc(comment.userId && comment.userId.profilePicture)}
                            >
                                {comment.userId && comment.userId.username ? comment.userId.username.charAt(0).toUpperCase() : '?'}
                            </Avatar>
                        )}
                        <div className="comment-content">
                            <div className="comment-header">
                                <div className="comment-meta">
                                    <Typography variant="subtitle2">
                                        {getUserDisplayName(comment.userId)}
                                    </Typography>
                                    <Typography variant="caption" color="text.secondary">
                                        {formatDistanceToNow(new Date(comment.createdAt))} ago
                                    </Typography>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center' }}>
                                    <Tooltip title="Reply">
                                        <IconButton
                                            size="small"
                                            className="comment-reply-button"
                                            onClick={() => { setReplyingTo(comment); commentInputRef.current?.focus(); }}
                                            aria-label="reply to comment"
                                        >
                                            <ReplyIcon fontSize="inherit" />
                                        </IconButton>
                                    </Tooltip>
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
                                </div>
                            </div>
                            <Typography variant="body2" className="comment-body">
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
                        </div>
                    </div>
                </Paper>
                );
            })}

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
