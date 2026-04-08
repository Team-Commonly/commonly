/* eslint-disable max-len */
import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import axios from 'axios';
import { useOutletContext, useNavigate, useLocation } from 'react-router-dom';
import {
    Typography, Avatar, Box, Button, Container, IconButton, Menu, MenuItem, Chip,
    Paper, TextField, Divider, CircularProgress, Skeleton, Autocomplete, ToggleButton, ToggleButtonGroup
} from '@mui/material';
import {
    ChatBubbleOutline,
    FavoriteBorder,
    Favorite,
    MoreVert,
    EmojiEmotions as EmojiEmotionsIcon,
    Image as ImageIcon,
    Send as SendIcon,
    Close as CloseIcon,
    Whatshot as WhatshotIcon,
    AccessTime as AccessTimeIcon,
} from '@mui/icons-material';
import { getAvatarColor, getAvatarSrc } from '../utils/avatarUtils';
import { normalizeUploadUrl } from '../utils/apiBaseUrl';
import { AgentAvatar, isAgentUsername } from './common/AgentIndicator';
import MarkdownContent from './common/MarkdownContent';
import { useAppContext } from '../context/AppContext';
import { blurActiveElement } from '../utils/focusUtils';
import { formatDistanceToNowSafe } from '../utils/dateUtils';
import EmojiPicker from 'emoji-picker-react';
import './PostFeed.css'; // Import the CSS file

interface PostUser {
    _id?: string;
    username?: string;
    profilePicture?: string | null;
    isBot?: boolean;
    botMetadata?: { displayName?: string } | null;
}

interface PostComment {
    _id?: string;
    createdAt?: string;
}

interface PostSource {
    provider?: string;
    url?: string;
}

interface Post {
    _id: string;
    content?: string;
    image?: string;
    tags?: string[];
    category?: string;
    podId?: string | { _id: string; name?: string } | null;
    userId?: PostUser;
    likes?: number;
    likedBy?: (string | { _id: string })[];
    comments?: PostComment[];
    createdAt?: string;
    source?: PostSource;
    agentCommentsDisabled?: boolean;
}

interface PodOption {
    _id: string;
    name: string;
    type?: string;
}

interface ResolvedAuthor {
    id: string | null;
    username: string;
    displayName: string;
    profilePicture: string | null;
    isBot: boolean;
    botMetadata: { displayName?: string } | null;
}

const PostFeed = () => {
    const {
        currentUser,
        setPosts: setContextPosts,
        refreshData,
        removePost,
        postsLoading
    } = useAppContext();
    const [posts, setPosts] = useState<Post[]>([]);
    const [error, setError] = useState('');
    const [likedPosts, setLikedPosts] = useState<Record<string, boolean>>({});
    const [menuAnchorEl, setMenuAnchorEl] = useState<null | HTMLElement>(null);
    const [selectedPostId, setSelectedPostId] = useState<string | null>(null);
    const searchResults = useOutletContext<Post[] | null>();
    const navigate = useNavigate();
    const location = useLocation();
    const CATEGORY_OPTIONS = ['General', 'Announcements', 'Ideas', 'Help', 'Resources', 'Social'];

    // Create post state
    const [postContent, setPostContent] = useState('');
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [tags, setTags] = useState<string[]>([]);
    const [selectedImage, setSelectedImage] = useState<File | null>(null);
    const [imagePreview, setImagePreview] = useState<string | null>(null);
    const [userPods, setUserPods] = useState<PodOption[]>([]);
    const [podsLoading, setPodsLoading] = useState(false);
    const [selectedPodId, setSelectedPodId] = useState('global');
    const [postCategory, setPostCategory] = useState('General');
    const [lightboxImage, setLightboxImage] = useState<string | null>(null);
    const [lightboxAlt, setLightboxAlt] = useState('');
    const [lightboxZoomed, setLightboxZoomed] = useState(false);
    const [sortMode, setSortMode] = useState('hot');
    const [page, setPage] = useState(1);
    const [hasMore, setHasMore] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const sentinelRef = useRef<HTMLDivElement>(null);
    const fileInputRef = React.useRef<HTMLInputElement>(null);
    const emojiButtonRef = React.useRef<HTMLButtonElement>(null);

    const searchParams = useMemo(() => new URLSearchParams(location.search), [location.search]);
    const activePodParam = searchParams.get('podId');
    const activeCategoryParam = searchParams.get('category');

    const podOptions = useMemo<PodOption[]>(() => (
        [{ _id: 'global', name: 'Global feed' }, ...(userPods || [])]
    ), [userPods]);

    const selectedPodOption = useMemo(() => (
        podOptions.find((pod) => pod._id === selectedPodId) || podOptions[0]
    ), [podOptions, selectedPodId]);

    // Extract hashtags from content
    useEffect(() => {
        const extractedTags = postContent.match(/#[\w]+/g) || [];
        setTags(extractedTags.map(tag => tag.slice(1))); // Remove # from tags
    }, [postContent]);

    useEffect(() => {
        if (!currentUser) return;
        const fetchPods = async () => {
            try {
                setPodsLoading(true);
                const res = await axios.get('/api/pods', {
                    headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
                });
                setUserPods(res.data || []);
            } catch (err: any) {
                console.warn('Failed to load pods for post composer:', err.response?.status);
                setUserPods([]);
            } finally {
                setPodsLoading(false);
            }
        };
        fetchPods();
    }, [currentUser]);

    useEffect(() => {
        setSelectedPodId(activePodParam || 'global');
        setPostCategory(activeCategoryParam || 'General');
    }, [activePodParam, activeCategoryParam]);

    // Handle clicking outside emoji picker
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent | TouchEvent) => {
            if (showEmojiPicker &&
                emojiButtonRef.current &&
                !emojiButtonRef.current.contains(event.target as Node) &&
                !(event.target as Element).closest('.emoji-picker-portal')) {
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

    const handleCreatePost = async (e: { preventDefault: () => void }) => {
        e.preventDefault();
        if (!postContent.trim() && !selectedImage) return;

        setIsSubmitting(true);
        try {
            let imageUrl: string | null = null;

            // If there's an image, upload it first
            if (selectedImage) {
                const imageFormData = new FormData();
                imageFormData.append('image', selectedImage);

                const imageResponse = await axios.post('/api/uploads', imageFormData, {
                    headers: {
                        Authorization: `Bearer ${localStorage.getItem('token')}`,
                        'Content-Type': 'multipart/form-data'
                    }
                });

                imageUrl = imageResponse.data.url;
            }

            const resolvedPodId = selectedPodId && selectedPodId !== 'global' ? selectedPodId : null;
            const postData: Record<string, any> = {
                content: postContent.trim() || "Posted an image",
                tags: tags,
                category: postCategory || 'General',
                ...(resolvedPodId ? { podId: resolvedPodId } : {})
            };

            if (imageUrl) {
                postData.image = imageUrl;
            }

            await axios.post('/api/posts', postData, {
                headers: {
                    Authorization: `Bearer ${localStorage.getItem('token')}`
                }
            });

            setPostContent('');
            setTags([]);
            setSelectedImage(null);
            setImagePreview(null);

            window.location.reload();
        } catch (err) {
            setError('Failed to create post. Please try again later.');
            console.error('Error creating post:', err);
        } finally {
            setIsSubmitting(false);
        }
    };

    const onEmojiClick = (emojiData: { emoji: string }) => {
        setPostContent(prevContent => prevContent + emojiData.emoji);
    };

    const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            setSelectedImage(file);
            const reader = new FileReader();
            reader.onloadend = () => {
                setImagePreview(reader.result as string);
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

    const updateFeedQuery = (updates: Record<string, string | null>) => {
        const params = new URLSearchParams(location.search);
        Object.entries(updates).forEach(([key, value]) => {
            if (!value) {
                params.delete(key);
            } else {
                params.set(key, value);
            }
        });
        const nextSearch = params.toString();
        navigate(`/feed${nextSearch ? `?${nextSearch}` : ''}`);
    };

    const handleCategoryFilter = (category: string | null) => {
        updateFeedQuery({ category });
    };

    const handleLike = async (postId: string) => {
        const isCurrentlyLiked = likedPosts[postId] || false;

        try {
            setLikedPosts({
                ...likedPosts,
                [postId]: !isCurrentlyLiked
            });

            const response = await axios.post(`/api/posts/${postId}/like`, {}, {
                headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
            });

            setPosts(posts.map(post => {
                if (post._id === postId) {
                    return { ...post, likes: response.data.likes };
                }
                return post;
            }));

            if (response.data.liked !== !isCurrentlyLiked) {
                setLikedPosts({
                    ...likedPosts,
                    [postId]: response.data.liked
                });
            }
        } catch (err) {
            console.error('Failed to like post:', err);
            setLikedPosts({
                ...likedPosts,
                [postId]: isCurrentlyLiked
            });
        }
    };

    const openLightbox = (src: string, alt = '') => {
        setLightboxImage(src);
        setLightboxAlt(alt);
        setLightboxZoomed(false);
    };

    const closeLightbox = () => {
        setLightboxImage(null);
        setLightboxAlt('');
        setLightboxZoomed(false);
    };

    const handleMenuOpen = (event: React.MouseEvent<HTMLButtonElement>, postId: string) => {
        event.stopPropagation();
        setMenuAnchorEl(event.currentTarget);
        setSelectedPostId(postId);
    };

    const handleMenuClose = () => {
        setMenuAnchorEl(null);
        setSelectedPostId(null);
        blurActiveElement();
    };

    const refreshPage = (delay = 0) => {
        setTimeout(() => {
            window.location.reload();
        }, delay);
    };

    const handleDeletePost = async () => {
        if (!selectedPostId) return;

        try {
            handleMenuClose();
            setPosts(posts.filter(post => post._id !== selectedPostId));
            removePost(selectedPostId);

            await axios.delete(`/api/posts/${selectedPostId}`, {
                headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
            });

            refreshPage(500);
        } catch (err) {
            console.error('Failed to delete post:', err);
            refreshData();
        }
    };

    const PAGE_SIZE = 20;

    const buildLikedStatus = useCallback((postList: Post[]): Record<string, boolean> => {
        if (!currentUser) return {};
        const status: Record<string, boolean> = {};
        postList.forEach((post) => {
            status[post._id] = post.likedBy?.some(
                (u) => ((u as any)._id || u) === currentUser._id
            ) || false;
        });
        return status;
    }, [currentUser]);

    const fetchPosts = useCallback(async (targetPage = 1, append = false) => {
        try {
            if (targetPage === 1 && !append) setPage(1);
            if (append) setLoadingMore(true);
            const params: Record<string, any> = { sort: sortMode, page: targetPage, limit: PAGE_SIZE };
            if (activePodParam) params.podId = activePodParam;
            if (activeCategoryParam) params.category = activeCategoryParam;
            const res = await axios.get('/api/posts', {
                headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
                params,
            });
            const incoming: Post[] = res.data?.posts ?? res.data ?? [];
            const more: boolean = res.data?.hasMore ?? false;
            setHasMore(more);
            if (append) {
                setPosts((prev) => {
                    const merged = [...prev, ...incoming];
                    setContextPosts(merged as any);
                    setLikedPosts((ls) => ({ ...ls, ...buildLikedStatus(incoming) }));
                    return merged;
                });
            } else {
                setPosts(incoming);
                setContextPosts(incoming as any);
                setLikedPosts(buildLikedStatus(incoming));
            }
        } catch (err) {
            setError('Failed to fetch posts. Please try again later.');
            if (!append) setPosts([]);
        } finally {
            setLoadingMore(false);
        }
    }, [currentUser, setContextPosts, activePodParam, activeCategoryParam, sortMode, buildLikedStatus]);

    useEffect(() => {
        if (searchResults !== null) return;
        if (!currentUser) return;
        setPage(1);
        setHasMore(true);
        fetchPosts(1, false);
    }, [sortMode, activePodParam, activeCategoryParam]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (searchResults !== null) {
            setPosts(searchResults);
            setLikedPosts(buildLikedStatus(searchResults));
        } else if (currentUser) {
            fetchPosts(1, false);
        }
    }, [searchResults, currentUser]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        const el = sentinelRef.current;
        if (!el) return undefined;
        const observer = new IntersectionObserver(
            ([entry]) => {
                if (entry.isIntersecting && hasMore && !loadingMore && !postsLoading) {
                    const next = page + 1;
                    setPage(next);
                    fetchPosts(next, true);
                }
            },
            { rootMargin: '200px' },
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, [hasMore, loadingMore, postsLoading, page, fetchPosts]);

    const resolvePodId = (value: Post['podId']): string | null => {
        if (!value) return null;
        if (typeof value === 'string') return value;
        return value._id || null;
    };

    const getPostAuthor = (post: Post): ResolvedAuthor => {
        const user = post?.userId;
        if (!user || typeof user !== 'object') {
            return {
                id: null,
                username: 'Unknown',
                displayName: 'Unknown',
                profilePicture: null,
                isBot: false,
                botMetadata: null,
            };
        }
        const displayName = (user.isBot && user.botMetadata?.displayName)
            ? user.botMetadata.displayName
            : (user.username || 'Unknown');
        return {
            id: user._id || null,
            username: user.username || 'Unknown',
            displayName,
            profilePicture: user.profilePicture || null,
            isBot: user.isBot || false,
            botMetadata: user.botMetadata || null,
        };
    };

    const getPostPodName = (post: Post): string | null => {
        if (!post?.podId) return null;
        if (typeof post.podId === 'object') return post.podId.name || null;
        const podMatch = (userPods || []).find((pod) => pod._id === post.podId);
        return podMatch?.name || null;
    };

    const scopedPosts = useMemo(() => {
        if (!activePodParam) return posts;
        if (activePodParam === 'global' || activePodParam === 'none') {
            return posts.filter((post) => !post.podId);
        }
        return posts.filter((post) => resolvePodId(post.podId) === activePodParam);
    }, [posts, activePodParam]);

    const filteredPosts = useMemo(() => {
        if (!activeCategoryParam) return scopedPosts;
        return scopedPosts.filter((post) => post.category === activeCategoryParam);
    }, [scopedPosts, activeCategoryParam]);

    const categoryGroups = useMemo(() => {
        const groups = new Map<string, Post[]>();
        scopedPosts.forEach((post) => {
            const category = post.category || 'General';
            const list = groups.get(category) || [];
            list.push(post);
            groups.set(category, list);
        });
        return Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length);
    }, [scopedPosts]);

    const activePod = useMemo(() => {
        if (!activePodParam || activePodParam === 'global' || activePodParam === 'none') return null;
        return (userPods || []).find((pod) => pod._id === activePodParam) || null;
    }, [activePodParam, userPods]);

    if (error) return <Typography color="error" sx={{ p: 2, mt: 8 }}>{error}</Typography>;

    return (
        <Container maxWidth="md" sx={{ py: 2, mt: 8 }} className="post-feed-container">
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
                                width: 32,
                                height: 32,
                                fontSize: '0.9rem'
                            }}
                            src={getAvatarSrc(currentUser.profilePicture)}
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
                                    fontSize: '1rem',
                                    p: 0.75
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

                        <Box className="composer-category-chips">
                            {CATEGORY_OPTIONS.map((option) => (
                                <Chip
                                    key={option}
                                    label={option}
                                    size="small"
                                    variant={postCategory === option ? 'filled' : 'outlined'}
                                    onClick={() => setPostCategory(option)}
                                    className="category-chip"
                                />
                            ))}
                        </Box>

                        <Box className="composer-actions-row">
                            <Box className="composer-actions-main">
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
                                <Autocomplete
                                    size="small"
                                    options={podOptions}
                                    value={selectedPodOption}
                                    loading={podsLoading}
                                    onChange={(_, value) => setSelectedPodId((value as PodOption)?._id || 'global')}
                                    getOptionLabel={(option) => (option as PodOption)?.name || 'Global feed'}
                                    isOptionEqualToValue={(option, value) => (option as PodOption)._id === (value as PodOption)._id}
                                    disableClearable
                                    className="composer-meta-inline"
                                    renderInput={(params) => (
                                        <TextField
                                            {...params}
                                            label="Post to"
                                            className="composer-meta-select"
                                        />
                                    )}
                                />
                            </Box>
                            <Button
                                variant="contained"
                                color="primary"
                                size="small"
                                disabled={(!postContent.trim() && !selectedImage) || isSubmitting}
                                onClick={handleCreatePost}
                                endIcon={isSubmitting ? <CircularProgress size={16} /> : <SendIcon />}
                                className="composer-post-button"
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
                                        backgroundColor: 'rgba(15, 23, 42, 0.6)',
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
                            emojiStyle={"native" as any}
                            searchDisabled={false}
                            skinTonesDisabled={true}
                            previewConfig={{ showPreview: false }}
                            style={{ transform: 'none', scale: '1' }}
                        />
                    </Box>
                </Box>
            )}

            {(activePod || activePodParam === 'global') && (
                <Paper className="feed-scope-banner">
                    <Box className="feed-scope-content">
                        <Box>
                            <Typography variant="subtitle2">
                                {activePod ? `Pod feed: ${activePod.name}` : 'Global feed'}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                                {activePod ? 'Posts shared inside this pod' : 'All community posts across pods'}
                            </Typography>
                        </Box>
                        <Box className="feed-scope-actions">
                            {activePod && (
                                <Button
                                    size="small"
                                    variant="outlined"
                                    onClick={() => navigate(`/pods/${activePod.type}/${activePod._id}`)}
                                >
                                    Open Pod Chat
                                </Button>
                            )}
                            {activePodParam && (
                                <Button
                                    size="small"
                                    variant="text"
                                    onClick={() => updateFeedQuery({ podId: null })}
                                >
                                    Clear pod filter
                                </Button>
                            )}
                        </Box>
                    </Box>
                </Paper>
            )}

            {activeCategoryParam && (
                <Paper className="feed-scope-banner">
                    <Box className="feed-scope-content">
                        <Box>
                            <Typography variant="subtitle2">
                                Category: {activeCategoryParam}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                                Filtering posts by category
                            </Typography>
                        </Box>
                        <Box className="feed-scope-actions">
                            <Button
                                size="small"
                                variant="text"
                                onClick={() => handleCategoryFilter(null)}
                            >
                                Clear category
                            </Button>
                        </Box>
                    </Box>
                </Paper>
            )}

            {categoryGroups.length > 0 && !activeCategoryParam && (
                <Box className="category-panel-grid">
                    {categoryGroups.slice(0, 6).map(([categoryName, categoryPosts]) => (
                        <Paper
                            key={categoryName}
                            className="category-panel"
                            onClick={() => handleCategoryFilter(categoryName)}
                        >
                            <Box className="category-panel-header">
                                <Typography variant="subtitle2">{categoryName}</Typography>
                                <Chip
                                    label={`${categoryPosts.length} posts`}
                                    size="small"
                                    className="category-count-chip"
                                />
                            </Box>
                            <Box className="category-panel-body">
                                {categoryPosts.slice(0, 2).map((post) => (
                                    <div key={post._id} className="category-panel-item">
                                        <Typography variant="body2" className="category-panel-title">
                                            {post.content?.slice(0, 80)}
                                        </Typography>
                                        <Typography variant="caption" color="text.secondary">
                                            {getPostAuthor(post).displayName} · {formatDistanceToNowSafe(post.createdAt)} ago
                                        </Typography>
                                    </div>
                                ))}
                            </Box>
                        </Paper>
                    ))}
                </Box>
            )}

            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
                <ToggleButtonGroup
                    value={sortMode}
                    exclusive
                    onChange={(_, v) => v && setSortMode(v)}
                    size="small"
                    sx={{
                        '& .MuiToggleButton-root': {
                            fontSize: '0.75rem',
                            px: 1.5,
                            py: 0.5,
                            textTransform: 'none',
                            gap: 0.5,
                        },
                    }}
                >
                    <ToggleButton value="hot">
                        <WhatshotIcon sx={{ fontSize: 14 }} />
                        Hot
                    </ToggleButton>
                    <ToggleButton value="recent">
                        <AccessTimeIcon sx={{ fontSize: 14 }} />
                        Recent
                    </ToggleButton>
                </ToggleButtonGroup>
            </Box>

            <Divider sx={{ mb: 3 }} />

            {/* Posts Feed */}
            {postsLoading ? (
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
            ) : filteredPosts.length === 0 ? (
                <Typography variant="body1" sx={{ textAlign: 'center', py: 4 }}>
                    No posts yet!
                </Typography>
            ) : (
                filteredPosts.map((post, _idx, arr) => {
                    const author = getPostAuthor(post);
                    const postContentText = typeof post?.content === 'string' ? post.content : '';

                    const computeScore = (p: Post) => {
                        const lc = p.likedBy?.length || p.likes || 0;
                        const cc = p.comments?.length || 0;
                        const lastReply = p.comments?.length
                            ? Math.max(...p.comments.map((c) => new Date(c.createdAt || 0).getTime()), new Date(p.createdAt || 0).getTime())
                            : new Date(p.createdAt || 0).getTime();
                        const ah = (Date.now() - lastReply) / 3600000;
                        return (lc + cc * 3) / Math.pow(ah + 2, 1.2);
                    };

                    const heatScore = computeScore(post);
                    const maxHeat = sortMode === 'hot'
                        ? Math.max(...arr.map(computeScore), 0.001)
                        : 1;
                    const heatLevel = Math.min(heatScore / maxHeat, 1);
                    const likeCount = post.likedBy?.length || post.likes || 0;
                    const hotBorderColor = heatLevel > 0.66 ? '#ef4444' : heatLevel > 0.33 ? '#f97316' : '#3b82f6';
                    return (
                    <Paper
                        key={post._id}
                        sx={{
                            mb: 3,
                            p: 2,
                            borderRadius: 2,
                            border: '1px solid #eaeaea',
                            overflow: 'hidden',
                            ...(sortMode === 'hot' && likeCount > 0 && {
                                borderLeft: `3px solid ${hotBorderColor}`,
                            }),
                        }}
                        className="post-card"
                        onClick={() => navigate(`/thread/${post._id}`)}
                    >
                        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5 }}>
                            {isAgentUsername(author.username) ? (
                                <AgentAvatar
                                    username={author.username}
                                    src={getAvatarSrc(author.profilePicture)}
                                    size={32}
                                    showBadge={false}
                                />
                            ) : (
                                <Avatar sx={{
                                    bgcolor: getAvatarColor(author.profilePicture),
                                    width: 32,
                                    height: 32,
                                    fontSize: '0.9rem'
                                }}
                                src={getAvatarSrc(author.profilePicture)}
                                >
                                    {author.displayName.charAt(0).toUpperCase()}
                                </Avatar>
                            )}
                            <Box sx={{ flex: 1 }}>
                                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.25 }}>
                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                        <Typography variant="body1" sx={{ fontWeight: 600, fontSize: '0.9rem' }}>
                                            {author.displayName}
                                        </Typography>
                                        {post.createdAt && (
                                            <Typography variant="caption" color="text.secondary">
                                                · {formatDistanceToNowSafe(post.createdAt)} ago
                                            </Typography>
                                        )}
                                    </Box>
                                    {currentUser && author.id && (currentUser._id === author.id) && (
                                        <IconButton
                                            size="small"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                handleMenuOpen(e, post._id);
                                            }}
                                            aria-label="post options"
                                            id="post-options-button"
                                        >
                                            <MoreVert />
                                        </IconButton>
                                    )}
                                </Box>

                                <Box className="post-meta-chips">
                                    <Chip
                                        label={post.category || 'General'}
                                        size="small"
                                        className="post-category-chip"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleCategoryFilter(post.category || 'General');
                                        }}
                                    />
                                    {resolvePodId(post.podId) && (
                                        <Chip
                                            label={getPostPodName(post) ? `Pod: ${getPostPodName(post)}` : 'Pod post'}
                                            size="small"
                                            variant="outlined"
                                            className="post-pod-chip"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                updateFeedQuery({ podId: resolvePodId(post.podId) });
                                            }}
                                        />
                                    )}
                                    {post.source?.provider && post.source.provider !== 'internal' && (
                                        <Chip
                                            label={post.source.provider}
                                            size="small"
                                            variant="outlined"
                                            className="post-source-chip"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                if (post.source?.url) {
                                                    window.open(post.source.url, '_blank', 'noopener,noreferrer');
                                                }
                                            }}
                                        />
                                    )}
                                    {post.agentCommentsDisabled && (
                                        <Chip
                                            label="Agents off"
                                            size="small"
                                            variant="outlined"
                                            className="post-agent-off-chip"
                                            onClick={(e) => e.stopPropagation()}
                                            sx={{ opacity: 0.65, fontSize: '0.7rem' }}
                                        />
                                    )}
                                </Box>

                                <Box className="post-content" sx={{ mb: 2, fontSize: '0.85rem' }}>
                                    <MarkdownContent
                                        variant="post"
                                        onHashtagClick={(tag: string) => {
                                            refreshData();
                                            window.location.href = `/feed?q=${tag}`;
                                        }}
                                    >
                                        {postContentText}
                                    </MarkdownContent>
                                </Box>

                                {post.image && (
                                    <Box
                                        sx={{
                                            mt: 1,
                                            mb: 2,
                                            borderRadius: '8px',
                                            overflow: 'hidden',
                                        }}
                                        className="post-image-container"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            openLightbox(normalizeUploadUrl(post.image!), post.content);
                                        }}
                                    >
                                        <Box
                                            component="img"
                                            src={normalizeUploadUrl(post.image)}
                                            alt="Post image"
                                            className="post-image"
                                        />
                                    </Box>
                                )}

                                <Box sx={{ display: 'flex', gap: 3, alignItems: 'center' }} className="post-actions">
                                    <Box
                                        sx={{ display: 'flex', alignItems: 'center', gap: 1 }}
                                        className={`action-button like-button ${likedPosts[post._id] ? 'active' : ''}`}
                                        onClick={(e) => {
                                            e.stopPropagation();
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
                                            e.stopPropagation();
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
                                    {sortMode === 'hot' && (
                                        <Box
                                            sx={{ display: 'flex', alignItems: 'flex-end', gap: '3px', ml: 'auto', pr: 0.5 }}
                                            title={`Activity: ${heatLevel > 0.66 ? 'High' : heatLevel > 0.33 ? 'Medium' : heatLevel > 0 ? 'Low' : 'None'}`}
                                        >
                                            {[0, 1, 2].map((i) => (
                                                <Box
                                                    key={i}
                                                    sx={{
                                                        width: 4,
                                                        height: 7 + i * 5,
                                                        borderRadius: '2px',
                                                        backgroundColor: heatLevel > i * 0.33
                                                            ? hotBorderColor
                                                            : 'action.disabledBackground',
                                                        transition: 'background-color 0.3s',
                                                    }}
                                                />
                                            ))}
                                        </Box>
                                    )}
                                </Box>
                            </Box>
                        </Box>
                    </Paper>
                    );
                })
            )}

            {/* Infinite scroll sentinel */}
            <Box ref={sentinelRef} sx={{ height: 1 }} />
            {loadingMore && (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
                    <CircularProgress size={24} />
                </Box>
            )}
            {!hasMore && posts.length > 0 && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textAlign: 'center', pb: 3 }}>
                    All posts loaded
                </Typography>
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
