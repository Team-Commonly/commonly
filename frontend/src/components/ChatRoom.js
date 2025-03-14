import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { 
    Container, Typography, Box, Paper, TextField, IconButton, 
    Avatar, Divider, List, ListItem, ListItemText, ListItemAvatar,
    Button, CircularProgress, AppBar, Toolbar, Badge, Chip, FormControlLabel, Switch,
    Portal, MenuItem
} from '@mui/material';
import { 
    Send as SendIcon, 
    ArrowBack as ArrowBackIcon,
    EmojiEmotions as EmojiIcon,
    AttachFile as AttachFileIcon,
    People as PeopleIcon,
    Chat as ChatIcon,
    Close as CloseIcon,
    Announcement as AnnouncementIcon,
    Link as LinkIcon,
    AssignmentTurnedIn as TaskIcon,
    Event as EventIcon,
    Search as SearchIcon,
    ExpandMore as ExpandMoreIcon,
    CheckCircle as CheckCircleIcon,
    RadioButtonUnchecked as UncheckedIcon,
    ChevronRight as ChevronRightIcon,
    KeyboardArrowRight as ArrowRightIcon,
    Menu as MenuIcon,
    KeyboardArrowLeft as ArrowLeftIcon
} from '@mui/icons-material';
import { formatDistanceToNow } from 'date-fns';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { useLayout } from '../context/LayoutContext';
import { getAvatarColor } from '../utils/avatarUtils';
import axios from 'axios';
import EmojiPicker from 'emoji-picker-react';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import './ChatRoom.css';

const ChatRoom = () => {
    const { currentUser } = useAuth();
    const { socket, connected, pgAvailable, joinPod, leavePod, sendMessage } = useSocket();
    const { isDashboardCollapsed } = useLayout(); // Using global layout context
    const { podType, roomId } = useParams();
    const navigate = useNavigate();
    const [room, setRoom] = useState(null);
    const [messages, setMessages] = useState([]);
    const [message, setMessage] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);
    const [showMembers, setShowMembers] = useState(true); // Start with sidebar visible
    const messagesEndRef = useRef(null);
    const [selectedFile, setSelectedFile] = useState(null);
    const [previewUrl, setPreviewUrl] = useState('');
    const [isUploading, setIsUploading] = useState(false);
    const fileInputRef = useRef(null);
    const emojiPickerRef = useRef(null);
    
    // State for real data from API
    const [announcements, setAnnouncements] = useState([]);
    const [externalLinks, setExternalLinks] = useState([]);
    
    // State for editing
    const [isEditingAnnouncement, setIsEditingAnnouncement] = useState(false);
    const [isEditingLinks, setIsEditingLinks] = useState(false);
    const [newAnnouncementTitle, setNewAnnouncementTitle] = useState('');
    const [newAnnouncementContent, setNewAnnouncementContent] = useState('');
    const [newLinkName, setNewLinkName] = useState('');
    const [newLinkUrl, setNewLinkUrl] = useState('');
    const [newLinkType, setNewLinkType] = useState('discord');
    const [qrCodeImage, setQrCodeImage] = useState(null);
    const qrCodeInputRef = useRef(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    
    // Mock data with English text
    const mockAnnouncements = [
        { id: 1, title: 'Announcement', content: '114.100.120.53:13000', time: '3 days ago' },
    ];
    
    const mockExternalLinks = [
        { id: 1, name: 'Discord', url: '#', icon: 'discord' },
        { id: 2, name: 'Telegram', url: '#', icon: 'telegram' },
        { id: 3, name: 'WeChat', url: '#', icon: 'wechat', isQRCode: true },
        { id: 4, name: 'GroupMe', url: '#', icon: 'groupme' },
    ];
    
    // Fetch pod details and messages
    useEffect(() => {
        const fetchPodAndMessages = async () => {
            setLoading(true);
            setMessages([]); // Clear existing messages while loading
            try {
                // Get the authentication token
                const token = localStorage.getItem('token');
                if (!token) {
                    setError('Authentication required. Please log in again.');
                    setLoading(false);
                    return;
                }

                const authHeaders = {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    }
                };

                // Check database connection status first
                let usePostgres = pgAvailable;
                if (typeof pgAvailable === 'undefined') {
                    try {
                        const statusRes = await axios.get('/api/pg/status', authHeaders);
                        usePostgres = statusRes.data.available;
                    } catch (err) {
                        console.warn('Failed to check database status:', err);
                        usePostgres = false;
                    }
                }

                // Fetch pod details - include podType in the URL
                const podResponse = await axios.get(`/api/pods/${podType}/${roomId}`, authHeaders);
                
                if (!podResponse.data) {
                    throw new Error('Pod not found');
                }
                
                setRoom(podResponse.data);
                
                // Fetch announcements
                try {
                    const announcementsResponse = await axios.get(`/api/pods/${roomId}/announcements`, authHeaders);
                    setAnnouncements(announcementsResponse.data || []);
                    console.log('Fetched announcements:', announcementsResponse.data);
                } catch (err) {
                    console.warn('Failed to fetch announcements:', err);
                    setAnnouncements(mockAnnouncements);
                }
                
                // Fetch external links
                try {
                    const linksResponse = await axios.get(`/api/pods/${roomId}/external-links`, authHeaders);
                    setExternalLinks(linksResponse.data || []);
                    console.log('Fetched external links:', linksResponse.data);
                } catch (err) {
                    console.warn('Failed to fetch external links:', err);
                    setExternalLinks(mockExternalLinks);
                }
                
                // Fetch messages - use the proper API endpoint based on PG availability
                const messagesEndpoint = usePostgres 
                    ? `/api/pg/messages/${roomId}` 
                    : `/api/messages/${roomId}`;
                
                console.log(`Fetching messages from: ${messagesEndpoint}, PG available: ${usePostgres}`);
                const messagesResponse = await axios.get(messagesEndpoint, authHeaders);
                setMessages(messagesResponse.data.reverse()); // Reverse to show oldest first
                setError(null);
            } catch (err) {
                console.error('Error fetching pod data:', err);
                if (err.response && err.response.status === 401) {
                    setError('Authentication required. Please log in again.');
                } else {
                    setError('Failed to load chat room. Please try again.');
                }
            } finally {
                setLoading(false);
            }
        };
        
        if (roomId && podType) {
            fetchPodAndMessages();
        } else {
            setError('Invalid pod ID or type');
            setLoading(false);
        }
    }, [roomId, podType, pgAvailable]);
    
    // Join pod room when socket connects
    useEffect(() => {
        if (connected && roomId && !error) {
            joinPod(roomId);
            
            // Listen for new messages
            socket.on('newMessage', (message) => {
                console.log('Received new message via socket:', message);
                
                // Check if this is a response to our own message (to prevent duplicates)
                // If the server sends back our own message, replace the temporary one
                setMessages(prevMessages => {
                    // Try to identify if we have a temporary message waiting for this response
                    const tempMessageIndex = prevMessages.findIndex(msg => 
                        // Look for a message with similar content posted at a similar time
                        msg.content === message.content && 
                        msg.messageType === message.messageType &&
                        !msg._id // Temporary messages don't have an _id from the server
                    );
                    
                    if (tempMessageIndex >= 0) {
                        // Replace temporary message with the server response
                        const updatedMessages = [...prevMessages];
                        updatedMessages[tempMessageIndex] = message;
                        return updatedMessages;
                    } else {
                        // This is a new message from someone else, add it
                        return [...prevMessages, message];
                    }
                });
            });
            
            // Clean up
            return () => {
                leavePod(roomId);
                socket.off('newMessage');
            };
        }
    }, [connected, roomId, socket, joinPod, leavePod, error]);
    
    // Add debugging for messages
    useEffect(() => {
        if (messages.length > 0) {
            console.log(`Messages array contains ${messages.length} messages`);
            // Log the first and last message for debugging
            if (messages.length > 0) {
                console.log('First message structure:', messages[0]);
                console.log('Last message structure:', messages[messages.length - 1]);
            }
        }
    }, [messages]);
    
    // Scroll to bottom when messages change
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);
    
    const handleFileSelect = (event) => {
        const file = event.target.files[0];
        if (file) {
            // Only allow images
            if (!file.type.startsWith('image/')) {
                alert('Please select an image file');
                return;
            }
            
            setSelectedFile(file);
            
            // Create a preview
            const reader = new FileReader();
            reader.onload = () => {
                setPreviewUrl(reader.result);
            };
            reader.readAsDataURL(file);
        }
    };
    
    const uploadFile = async () => {
        if (!selectedFile) return null;
        
        const formData = new FormData();
        formData.append('image', selectedFile);
        
        try {
            setIsUploading(true);
            const token = localStorage.getItem('token');
            
            const response = await axios.post('/api/uploads', formData, {
                headers: {
                    'Content-Type': 'multipart/form-data',
                    'Authorization': `Bearer ${token}`
                }
            });
            
            setIsUploading(false);
            // The URL is now an API endpoint that serves the file from the database
            return response.data.url;
        } catch (error) {
            console.error('Error uploading file:', error);
            setIsUploading(false);
            setError('Failed to upload image');
            return null;
        }
    };
    
    const handleSendMessage = async (e) => {
        e.preventDefault();
        
        // Don't submit if nothing to send or if uploading
        if ((!message.trim() && !selectedFile) || isUploading) return;
        
        try {
            // Handle image upload first if present
            if (selectedFile) {
                setIsUploading(true);
                
                const formData = new FormData();
                formData.append('image', selectedFile);
                
                // Upload the image
                const token = localStorage.getItem('token');
                if (!token) {
                    setError('Authentication required. Please log in again.');
                    return;
                }
                
                try {
                    const response = await axios.post('/api/uploads', formData, {
                        headers: {
                            'Content-Type': 'multipart/form-data',
                            'Authorization': `Bearer ${token}`
                        }
                    });
                    
                    // Send the image message
                    const imageUrl = response.data.url;
                    
                    // Create a temporary message object for optimistic UI
                    const tempImageMessage = {
                        id: Date.now() + 1, // unique temporary ID
                        content: imageUrl,  // Store the API URL that serves the file from the database
                        text: imageUrl,     // For backward compatibility
                        podId: roomId,
                        messageType: 'image',
                        userId: {
                            _id: currentUser?._id,
                            username: currentUser?.username,
                            profilePicture: currentUser?.profilePicture
                        },
                        createdAt: new Date()
                    };
                    
                    // Add image message to UI immediately
                    setMessages(prev => [...prev, tempImageMessage]);
                    
                    // Send image message via socket
                    sendMessage(roomId, imageUrl, 'image');
                    
                } catch (err) {
                    console.error('Failed to upload image:', err);
                    setError('Failed to upload image. Please try again.');
                } finally {
                    setIsUploading(false);
                    setSelectedFile(null);
                    setPreviewUrl('');
                }
            }
            
            // Handle text message if present
            if (message.trim()) {
                // Create a temporary text message for optimistic UI
                const tempTextMessage = {
                    id: Date.now(), // temporary ID
                    content: message,    // Use content consistently with the server
                    text: message,       // For backward compatibility
                    podId: roomId,
                    messageType: 'text',
                    userId: {
                        _id: currentUser?._id,
                        username: currentUser?.username,
                        profilePicture: currentUser?.profilePicture
                    },
                    createdAt: new Date()
                };
                
                // Add text message to UI immediately
                setMessages(prev => [...prev, tempTextMessage]);
                
                // Send text message via socket
                sendMessage(roomId, message, 'text');
                
                // Clear the message input
                setMessage('');
            }
            
        } catch (err) {
            console.error('Failed to send message:', err);
            setError('Failed to send message. Please try again.');
        }
    };
    
    const onEmojiClick = (emojiObj) => {
        console.log('Emoji selected:', emojiObj);
        // Support multiple emoji picker library versions
        const emoji = emojiObj.emoji || emojiObj.native || 
                    (emojiObj.unified && String.fromCodePoint(parseInt(emojiObj.unified.split('-')[0], 16)));
        
        if (emoji) {
            setMessage(prevMessage => prevMessage + emoji);
            // Uncomment this to close the picker after selection
            // setShowEmojiPicker(false);
        }
    };
    
    // Toggle emoji picker
    const toggleEmojiPicker = () => {
        setShowEmojiPicker(prev => !prev);
    };
    
    // Close emoji picker when clicking outside
    useEffect(() => {
        const handleClickOutside = (event) => {
            if (emojiPickerRef.current && !emojiPickerRef.current.contains(event.target) && 
                !event.target.closest('.emoji-button')) {
                setShowEmojiPicker(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, []);

    // Log when emoji picker visibility changes
    useEffect(() => {
        console.log('Emoji picker visibility changed:', showEmojiPicker);
    }, [showEmojiPicker]);
    
    // Add a log to check if the sidebar should be visible
    useEffect(() => {
        console.log('Show members state:', showMembers);
    }, [showMembers]);
    
    // Add better debugging for visibility
    useEffect(() => {
        console.log('Show members state updated:', showMembers);
        
        // Debug sidebar visibility after render
        setTimeout(() => {
            const sidebar = document.querySelector('.members-sidebar');
            if (sidebar) {
                console.log('Sidebar element found:', sidebar);
                console.log('Sidebar visibility:', window.getComputedStyle(sidebar).display);
                console.log('Sidebar transform:', window.getComputedStyle(sidebar).transform);
            } else {
                console.log('Sidebar element not found in DOM');
            }
        }, 500);
    }, [showMembers]);
    
    // Log sidebar visibility changes
    useEffect(() => {
        console.log('Sidebar visibility changed:', showMembers);
        
        // Force body class update when sidebar visibility changes
        if (showMembers) {
            document.body.classList.add('sidebar-visible');
        } else {
            document.body.classList.remove('sidebar-visible');
        }
    }, [showMembers]);
    
    // Function to refresh pod data including announcements and links
    const refreshData = async () => {
        try {
            const token = localStorage.getItem('token');
            if (!token) {
                setError('Authentication required. Please log in again.');
                return;
            }

            const authHeaders = {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            };

            // Fetch pod details with announcements and links
            const podResponse = await axios.get(`/api/pods/${podType}/${roomId}`, authHeaders);
            
            if (!podResponse.data) {
                throw new Error('Pod not found');
            }
            
            setRoom(podResponse.data);
        } catch (err) {
            console.error('Error refreshing pod data:', err);
        }
    };

    // Handle adding new announcement with backend integration
    const handleAddAnnouncement = async () => {
        if (!newAnnouncementTitle.trim() || !newAnnouncementContent.trim()) {
            return;
        }

        try {
            setIsSubmitting(true);
            
            // Create announcement data
            const announcementData = {
                podId: roomId,
                title: newAnnouncementTitle,
                content: newAnnouncementContent
            };
            
            console.log('Sending announcement data:', announcementData);
            
            // API call to create announcement - try with error handling
            try {
                const response = await axios.post('/api/pods/announcement', announcementData, {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${localStorage.getItem('token')}`
                    }
                });
                
                if (response.status === 201) {
                    console.log('Announcement created successfully:', response.data);
                    
                    // Add the new announcement to the list
                    setAnnouncements(prev => [response.data, ...prev]);
                    
                    // Reset form
                    setIsEditingAnnouncement(false);
                    setNewAnnouncementTitle('');
                    setNewAnnouncementContent('');
                }
            } catch (apiError) {
                console.error('API error creating announcement:', apiError);
                if (apiError.response && apiError.response.data) {
                    console.error('API error details:', apiError.response.data);
                    setError(apiError.response.data.message || 'Failed to create announcement.');
                } else {
                    setError('Server error. Please try again later.');
                }
            }
        } catch (error) {
            console.error('Error in handleAddAnnouncement:', error);
            setError('Failed to create announcement. Please try again later.');
        } finally {
            setIsSubmitting(false);
        }
    };

    // Handle adding new external link with file upload capability
    const handleAddLink = async () => {
        if (!newLinkName.trim() || (!newLinkUrl.trim() && !qrCodeImage && newLinkType !== 'wechat')) {
            return;
        }

        try {
            setIsSubmitting(true);
            
            // Create link data
            const linkData = new FormData();
            linkData.append('podId', roomId);
            linkData.append('name', newLinkName);
            linkData.append('type', newLinkType);
            
            // If WeChat QR code, handle file upload
            if (newLinkType === 'wechat' && qrCodeImage) {
                // Convert base64 to blob if needed
                if (qrCodeImage.startsWith('data:')) {
                    const response = await fetch(qrCodeImage);
                    const blob = await response.blob();
                    linkData.append('qrCode', blob, 'qrcode.png');
                }
            } else {
                // For regular links
                linkData.append('url', newLinkUrl);
            }
            
            console.log('Sending external link data:', Object.fromEntries(linkData.entries()));
            
            // API call to create external link - with proper error handling
            try {
                const response = await axios.post('/api/pods/external-link', linkData, {
                    headers: {
                        'Authorization': `Bearer ${localStorage.getItem('token')}`,
                        'Content-Type': 'multipart/form-data'
                    }
                });
                
                if (response.status === 201) {
                    console.log('External link created successfully:', response.data);
                    
                    // Add the new link to the list
                    setExternalLinks(prev => [response.data, ...prev]);
                    
                    // Reset form
                    setIsEditingLinks(false);
                    setNewLinkName('');
                    setNewLinkUrl('');
                    setNewLinkType('discord');
                    setQrCodeImage(null);
                }
            } catch (apiError) {
                console.error('API error creating external link:', apiError);
                if (apiError.response && apiError.response.data) {
                    console.error('API error details:', apiError.response.data);
                    setError(apiError.response.data.message || 'Failed to create external link.');
                } else {
                    setError('Server error. Please try again later.');
                }
            }
        } catch (error) {
            console.error('Error in handleAddLink:', error);
            setError('Failed to create external link. Please try again later.');
        } finally {
            setIsSubmitting(false);
        }
    };

    // Handle QR code upload with proper file handling
    const handleQRCodeUpload = (e) => {
        if (e.target.files && e.target.files[0]) {
            const file = e.target.files[0];
            
            // Check file size (max 2MB)
            if (file.size > 2 * 1024 * 1024) {
                alert('File size exceeds 2MB limit');
                return;
            }
            
            // Check file type
            if (!file.type.match('image.*')) {
                alert('Only image files are allowed');
                return;
            }
            
            const reader = new FileReader();
            reader.onload = (e) => {
                setQrCodeImage(e.target.result);
            };
            reader.readAsDataURL(file);
        }
    };
    
    // Log visibility changes for debugging
    useEffect(() => {
        console.log('Sidebar visibility:', showMembers);
    }, [showMembers]);
    
    // Handle deleting an announcement
    const handleDeleteAnnouncement = async (announcementId) => {
        try {
            // Get auth token
            const token = localStorage.getItem('token');
            if (!token) {
                setError('Authentication required. Please log in again.');
                return;
            }
            
            // Make delete request
            await axios.delete(`/api/pods/announcement/${announcementId}`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            
            // Remove from state
            setAnnouncements(prev => prev.filter(a => a._id !== announcementId && a.id !== announcementId));
            
        } catch (error) {
            console.error('Error deleting announcement:', error);
            setError('Failed to delete announcement. Please try again.');
        }
    };
    
    // Handle deleting an external link
    const handleDeleteExternalLink = async (linkId) => {
        try {
            // Get auth token
            const token = localStorage.getItem('token');
            if (!token) {
                setError('Authentication required. Please log in again.');
                return;
            }
            
            // Make delete request
            await axios.delete(`/api/pods/external-link/${linkId}`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            
            // Remove from state
            setExternalLinks(prev => prev.filter(link => link._id !== linkId && link.id !== linkId));
            
        } catch (error) {
            console.error('Error deleting external link:', error);
            setError('Failed to delete external link. Please try again.');
        }
    };
    
    // Early exit for loading or error states
    if (loading) {
        return <CircularProgress />;
    }

    if (error) {
        return <Typography color="error">{error}</Typography>;
    }

    return (
        <>
            {/* Sidebar backdrop only used on mobile */}
            <div 
                className={`sidebar-backdrop ${showMembers ? 'visible' : ''}`}
                onClick={() => setShowMembers(false)}
            ></div>
            
            {/* Sidebar - now a side panel instead of full overlay */}
            <div 
                className={`members-sidebar ${!showMembers ? 'hidden' : ''}`}
            >
                {/* Sidebar content */}
                <div className="sidebar-section">
                    <div className="sidebar-section-title">
                        <div className="members-count">
                            <PeopleIcon style={{ color: '#1d9bf0' }} /> Members {room?.members?.length || 0}
                        </div>
                    </div>
                    
                    {/* Move search box to its own container */}
                    <div className="sidebar-search-container">
                        <TextField 
                            size="small"
                            placeholder="Search members..."
                            variant="outlined"
                            fullWidth
                            InputProps={{
                                startAdornment: <SearchIcon fontSize="small" sx={{ mr: 1, color: '#757575' }} />
                            }}
                            sx={{ 
                                bgcolor: '#f5f8fa', 
                                borderRadius: '4px',
                                '& .MuiOutlinedInput-root': {
                                    color: '#333333',
                                    '& fieldset': { border: 'none' },
                                    borderRadius: '4px'
                                }
                            }}
                        />
                    </div>
                    
                    <div className="sidebar-section-content">
                        {room?.members?.map(member => (
                            <div key={member._id} className="sidebar-member">
                                <Avatar 
                                    className="sidebar-member-avatar"
                                    sx={{ bgcolor: getAvatarColor(member.profilePicture || 'default'), width: 32, height: 32 }}
                                >
                                    {member.username?.charAt(0).toUpperCase()}
                                </Avatar>
                                <div className="sidebar-member-info">
                                    <div className="sidebar-member-name">{member.username}</div>
                                    {member._id === room?.createdBy?._id && (
                                        <div className="sidebar-member-role">Owner</div>
                                    )}
                                </div>
                                <div className={`sidebar-member-status ${member._id === currentUser?._id ? '' : (Math.random() > 0.3 ? '' : 'offline')}`}></div>
                            </div>
                        ))}
                    </div>
                </div>
                
                {/* Announcements section */}
                <div className="sidebar-section">
                    <div className="sidebar-section-title">
                        <span><AnnouncementIcon style={{ marginRight: '8px', fontSize: '16px', color: '#1d9bf0' }} /> Announcements</span>
                        <IconButton 
                            size="small" 
                            onClick={() => room?.createdBy?._id === currentUser?._id ? setIsEditingAnnouncement(!isEditingAnnouncement) : null}
                            sx={{ 
                                padding: '4px',
                                color: room?.createdBy?._id === currentUser?._id ? '#1d9bf0' : 'rgba(0,0,0,0.3)', 
                                '&.Mui-disabled': {
                                    color: 'rgba(0,0,0,0.2)',
                                },
                                cursor: room?.createdBy?._id === currentUser?._id ? 'pointer' : 'not-allowed'
                            }}
                        >
                            {isEditingAnnouncement ? <CloseIcon fontSize="small" /> : <ChevronRightIcon />}
                        </IconButton>
                    </div>
                    <div className="sidebar-section-content">
                        {isEditingAnnouncement && room?.createdBy?._id === currentUser?._id && (
                            <Box sx={{ mb: 2, p: 1, bgcolor: '#f5f8fa', borderRadius: '4px' }}>
                                <TextField
                                    fullWidth
                                    placeholder="Announcement Title"
                                    value={newAnnouncementTitle}
                                    onChange={(e) => setNewAnnouncementTitle(e.target.value)}
                                    variant="outlined"
                                    size="small"
                                    sx={{ 
                                        mb: 1,
                                        '& .MuiOutlinedInput-root': {
                                            color: '#333333',
                                            '& fieldset': { borderColor: '#e0e0e0' }
                                        }
                                    }}
                                />
                                <TextField
                                    fullWidth
                                    placeholder="Announcement Content"
                                    value={newAnnouncementContent}
                                    onChange={(e) => setNewAnnouncementContent(e.target.value)}
                                    variant="outlined"
                                    size="small"
                                    multiline
                                    rows={2}
                                    sx={{ 
                                        mb: 1,
                                        '& .MuiOutlinedInput-root': {
                                            color: '#333333',
                                            '& fieldset': { borderColor: '#e0e0e0' }
                                        }
                                    }}
                                />
                                {error && (
                                    <Box sx={{ 
                                        p: 1, 
                                        mb: 1, 
                                        bgcolor: 'rgba(255,0,0,0.05)', 
                                        borderRadius: '4px',
                                        color: '#ff4040',
                                        fontSize: '12px',
                                        display: 'flex',
                                        alignItems: 'center'
                                    }}>
                                        <span>{error}</span>
                                        <IconButton 
                                            size="small" 
                                            sx={{ ml: 'auto', color: '#ff4040', p: '2px' }}
                                            onClick={() => setError('')}
                                        >
                                            <CloseIcon fontSize="small" />
                                        </IconButton>
                                    </Box>
                                )}
                                <Button 
                                    variant="contained" 
                                    color="primary" 
                                    size="small" 
                                    fullWidth
                                    onClick={handleAddAnnouncement}
                                    disabled={isSubmitting || !newAnnouncementTitle.trim() || !newAnnouncementContent.trim()}
                                    sx={{
                                        bgcolor: '#1d9bf0',
                                        '&:hover': { bgcolor: '#0c8bd9' },
                                        '&.Mui-disabled': { bgcolor: '#e0e0e0', color: '#9e9e9e' }
                                    }}
                                >
                                    {isSubmitting ? 'Saving...' : 'Save Announcement'}
                                </Button>
                            </Box>
                        )}
                        {announcements.map(announcement => (
                            <div key={announcement._id || announcement.id} className="announcement-item">
                                <div className="announcement-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                                    <div className="announcement-title">{announcement.title}</div>
                                    {room?.createdBy?._id === currentUser?._id && (
                                        <IconButton 
                                            size="small" 
                                            onClick={() => handleDeleteAnnouncement(announcement._id || announcement.id)}
                                            sx={{ 
                                                padding: '2px', 
                                                color: '#a0a0a0',
                                                '&:hover': { color: '#ff4040', backgroundColor: 'rgba(255,0,0,0.05)' } 
                                            }}
                                        >
                                            <CloseIcon fontSize="small" />
                                        </IconButton>
                                    )}
                                </div>
                                <div className="announcement-content" style={{ 
                                    wordBreak: 'break-word', 
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    display: '-webkit-box',
                                    WebkitLineClamp: '3',
                                    WebkitBoxOrient: 'vertical',
                                    maxHeight: '60px'
                                }}>
                                    {announcement.content}
                                </div>
                                <div className="announcement-time">
                                    {announcement.createdAt 
                                        ? formatDistanceToNow(new Date(announcement.createdAt), { addSuffix: true })
                                        : announcement.time || 'Recently'}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
                
                {/* External links section */}
                <div className="sidebar-section">
                    <div className="sidebar-section-title">
                        <span><LinkIcon style={{ marginRight: '8px', fontSize: '16px', color: '#1d9bf0' }} /> External Links</span>
                        <IconButton 
                            size="small" 
                            onClick={() => room?.createdBy?._id === currentUser?._id ? setIsEditingLinks(!isEditingLinks) : null}
                            sx={{ 
                                padding: '4px',
                                color: room?.createdBy?._id === currentUser?._id ? '#1d9bf0' : 'rgba(0,0,0,0.3)', 
                                '&.Mui-disabled': {
                                    color: 'rgba(0,0,0,0.2)',
                                },
                                cursor: room?.createdBy?._id === currentUser?._id ? 'pointer' : 'not-allowed'
                            }}
                        >
                            {isEditingLinks ? <CloseIcon fontSize="small" /> : <ChevronRightIcon />}
                        </IconButton>
                    </div>
                    <div className="sidebar-section-content">
                        {/* Link edit form */}
                        {isEditingLinks && room?.createdBy?._id === currentUser?._id && (
                            <Box sx={{ mb: 2, p: 1, bgcolor: '#f5f8fa', borderRadius: '4px' }}>
                                <TextField
                                    fullWidth
                                    placeholder="Link Name (e.g. Discord)"
                                    value={newLinkName}
                                    onChange={(e) => setNewLinkName(e.target.value)}
                                    variant="outlined"
                                    size="small"
                                    sx={{ 
                                        mb: 1,
                                        '& .MuiOutlinedInput-root': {
                                            color: '#333333',
                                            '& fieldset': { borderColor: '#e0e0e0' }
                                        }
                                    }}
                                />
                                
                                <TextField
                                    select
                                    fullWidth
                                    value={newLinkType}
                                    onChange={(e) => setNewLinkType(e.target.value)}
                                    variant="outlined"
                                    size="small"
                                    sx={{ 
                                        mb: 1,
                                        '& .MuiOutlinedInput-root': {
                                            color: '#333333',
                                            '& fieldset': { borderColor: '#e0e0e0' },
                                            '& .MuiSelect-icon': {
                                                color: '#757575'
                                            }
                                        }
                                    }}
                                >
                                    <MenuItem value="discord">Discord</MenuItem>
                                    <MenuItem value="telegram">Telegram</MenuItem>
                                    <MenuItem value="wechat">WeChat</MenuItem>
                                    <MenuItem value="groupme">GroupMe</MenuItem>
                                    <MenuItem value="other">Other</MenuItem>
                                </TextField>
                                
                                {newLinkType !== 'wechat' && (
                                    <TextField
                                        fullWidth
                                        placeholder="Link URL"
                                        value={newLinkUrl}
                                        onChange={(e) => setNewLinkUrl(e.target.value)}
                                        variant="outlined"
                                        size="small"
                                        sx={{ 
                                            mb: 1,
                                            '& .MuiOutlinedInput-root': {
                                                color: '#333333',
                                                '& fieldset': { borderColor: '#e0e0e0' }
                                            }
                                        }}
                                    />
                                )}
                                
                                {newLinkType === 'wechat' && (
                                    <Box sx={{ textAlign: 'center', mb: 1 }}>
                                        <input
                                            type="file"
                                            accept="image/*"
                                            style={{ display: 'none' }}
                                            onChange={handleQRCodeUpload}
                                            ref={qrCodeInputRef}
                                        />
                                        
                                        {qrCodeImage ? (
                                            <Box sx={{ position: 'relative', display: 'inline-block' }}>
                                                <img src={qrCodeImage} alt="QR Code" className="qr-code-preview" />
                                                <IconButton 
                                                    size="small" 
                                                    sx={{ 
                                                        position: 'absolute', 
                                                        top: -10, 
                                                        right: -10,
                                                        bgcolor: 'rgba(0,0,0,0.7)', 
                                                        color: '#fff',
                                                        p: '4px',
                                                        '&:hover': { bgcolor: 'rgba(255,0,0,0.7)' }
                                                    }}
                                                    onClick={() => setQrCodeImage(null)}
                                                >
                                                    <CloseIcon fontSize="small" />
                                                </IconButton>
                                            </Box>
                                        ) : (
                                            <Button 
                                                variant="outlined" 
                                                color="primary" 
                                                size="small"
                                                onClick={() => qrCodeInputRef.current?.click()}
                                                sx={{ 
                                                    borderColor: '#1d9bf0',
                                                    color: '#1d9bf0',
                                                    '&:hover': { borderColor: '#0c8bd9', backgroundColor: 'rgba(29, 161, 242, 0.05)' }
                                                }}
                                            >
                                                Upload QR Code
                                            </Button>
                                        )}
                                    </Box>
                                )}
                                
                                {error && (
                                    <Box sx={{ 
                                        p: 1, 
                                        mb: 1, 
                                        bgcolor: 'rgba(255,0,0,0.05)', 
                                        borderRadius: '4px',
                                        color: '#ff4040',
                                        fontSize: '12px',
                                        display: 'flex',
                                        alignItems: 'center'
                                    }}>
                                        <span>{error}</span>
                                        <IconButton 
                                            size="small" 
                                            sx={{ ml: 'auto', color: '#ff4040', p: '2px' }}
                                            onClick={() => setError('')}
                                        >
                                            <CloseIcon fontSize="small" />
                                        </IconButton>
                                    </Box>
                                )}
                                
                                <Button 
                                    variant="contained" 
                                    color="primary" 
                                    size="small" 
                                    fullWidth
                                    onClick={handleAddLink}
                                    disabled={isSubmitting || !newLinkName.trim() || 
                                             (newLinkType !== 'wechat' && !newLinkUrl.trim()) || 
                                             (newLinkType === 'wechat' && !qrCodeImage)}
                                    sx={{
                                        bgcolor: '#1d9bf0',
                                        '&:hover': { bgcolor: '#0c8bd9' },
                                        '&.Mui-disabled': { bgcolor: '#e0e0e0', color: '#9e9e9e' }
                                    }}
                                >
                                    {isSubmitting ? 'Saving...' : 'Save Link'}
                                </Button>
                            </Box>
                        )}
                        
                        {externalLinks.map(link => (
                            <div key={link._id || link.id} className="external-link-container" style={{ 
                                position: 'relative', 
                                display: 'flex', 
                                alignItems: 'center',
                                marginBottom: '4px' 
                            }}>
                                <a 
                                    href={link.url} 
                                    className="external-link" 
                                    target="_blank" 
                                    rel="noopener noreferrer"
                                    style={{ flex: 1, paddingRight: room?.createdBy?._id === currentUser?._id ? '30px' : '0' }}
                                >
                                    {/* Discord icon */}
                                    {(link.type === 'discord' || link.icon === 'discord') && (
                                        <div className="external-link-icon">
                                            <img 
                                                src="https://discord.com/assets/f9bb9c4af2b9c32a2c5ee0014661546d.png" 
                                                width="16" 
                                                height="16" 
                                                alt="Discord" 
                                                onError={(e) => {
                                                    e.target.onerror = null;
                                                    e.target.parentNode.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="#5865F2"><path d="M19.952,5.672c-1.904-1.531-4.916-1.79-5.044-1.801c-0.201-0.017-0.392,0.097-0.474,0.281 c0.006,0.012-0.072,0.163-0.145,0.398c1.259,0.212,2.806,0.64,4.206,1.509c0.224,0.139,0.293,0.434,0.154,0.659 c-0.09,0.146-0.247,0.226-0.407,0.226c-0.086,0-0.173-0.023-0.252-0.072C15.584,5.38,12.578,5.305,12,5.305S8.415,5.38,6.011,6.872 c-0.225,0.14-0.519,0.07-0.659-0.154c-0.14-0.225-0.07-0.519,0.154-0.659c1.4-0.868,2.947-1.297,4.206-1.509 c-0.074-0.236-0.14-0.386-0.145-0.398C9.484,3.968,9.294,3.852,9.092,3.872c-0.127,0.01-3.139,0.269-5.069,1.822 C3.015,6.625,1,12.073,1,16.783c0,0.083,0.022,0.165,0.063,0.237c1.391,2.443,5.185,3.083,6.05,3.111c0.005,0,0.01,0,0.015,0 c0.153,0,0.297-0.073,0.387-0.197l0.875-1.202c-2.359-0.61-3.564-1.645-3.634-1.706c-0.198-0.175-0.217-0.477-0.042-0.675 c0.175-0.198,0.476-0.217,0.674-0.043c0.029,0.026,2.248,1.909,6.612,1.909c4.372,0,6.591-1.891,6.613-1.91 c0.198-0.172,0.5-0.154,0.674,0.045c0.174,0.198,0.155,0.499-0.042,0.673c-0.07,0.062-1.275,1.096-3.634,1.706l0.875,1.202 c0.09,0.124,0.234,0.197,0.387,0.197c0.005,0,0.01,0,0.015,0c0.865-0.027,4.659-0.667,6.05-3.111 C22.978,16.947,23,16.866,23,16.783C23,12.073,20.985,6.625,19.952,5.672z M8.891,14.87c-0.924,0-1.674-0.857-1.674-1.913 s0.749-1.913,1.674-1.913s1.674,0.857,1.674,1.913S9.816,14.87,8.891,14.87z M15.109,14.87c-0.924,0-1.674-0.857-1.674-1.913 s0.749-1.913,1.674-1.913c0.924,0,1.674,0.857,1.674,1.913S16.033,14.87,15.109,14.87z"></path></svg>';
                                                }}
                                            />
                                        </div>
                                    )}
                                    
                                    {/* Telegram icon */}
                                    {(link.type === 'telegram' || link.icon === 'telegram') && (
                                        <div className="external-link-icon" style={{ backgroundColor: '#31a8df' }}>
                                            <img 
                                                src="https://telegram.org/img/t_logo.png" 
                                                width="16" 
                                                height="16" 
                                                alt="Telegram" 
                                                onError={(e) => {
                                                    e.target.onerror = null;
                                                    e.target.parentNode.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="#FFFFFF"><path d="M19.2,4.4L2.9,10.7c-1.1,0.4-1.1,1.1-0.2,1.3l4.1,1.3l1.6,4.8c0.2,0.5,0.1,0.7,0.6,0.7c0.4,0,0.6-0.2,0.8-0.4 c0.1-0.1,1-1,2-2l4.2,3.1c0.8,0.4,1.3,0.2,1.5-0.7l2.8-13.1C20.6,4.6,19.9,4,19.2,4.4z M17.1,7.4l-7.8,7.1L9,17.8L7.4,13 l9.2-5.8C17,6.9,17.4,7.1,17.1,7.4z"></path></svg>';
                                                }}
                                            />
                                        </div>
                                    )}
                                    
                                    {/* WeChat icon */}
                                    {(link.type === 'wechat' || link.icon === 'wechat') && (
                                        <div className="external-link-icon" style={{ backgroundColor: '#2DC100' }}>
                                            <img 
                                                src="https://img.icons8.com/color/48/wechat.png" 
                                                width="16" 
                                                height="16" 
                                                alt="WeChat" 
                                                onError={(e) => {
                                                    e.target.onerror = null;
                                                    e.target.parentNode.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="#FFFFFF"><path d="M8.691,2.188C3.891,2.188,0,5.476,0,9.53c0,2.256,1.305,4.296,3.357,5.605c-0.254,0.94-0.636,2.348-0.636,2.348 c-0.034,0.127,0.010,0.267,0.110,0.369c0.073,0.070,0.171,0.108,0.269,0.108c0.049,0,0.098-0.010,0.144-0.029 c0,0,2.022-1.166,2.37-1.366c0.988,0.256,2.015,0.394,3.076,0.394c0.168,0,0.336-0.007,0.504-0.014 c-0.272-0.804-0.418-1.66-0.418-2.546c0-4.439,4.253-8.030,9.504-8.030c0.303,0,0.602,0.015,0.896,0.041 C18.248,3.159,13.93,2.188,8.691,2.188z M5.726,7.537c-0.818,0-1.48-0.662-1.48-1.48s0.662-1.48,1.48-1.48s1.48,0.662,1.48,1.48 S6.544,7.537,5.726,7.537z M11.655,7.537c-0.818,0-1.48-0.662-1.48-1.48-1.48s0.662-1.48,1.48-1.48s1.48,0.662,1.48,1.48 S12.473,7.537,11.655,7.537z M14.727,13.845c0.168,0,0.336,0.007,0.504,0.014c0.605-0.477,1.347-0.843,2.166-1.078 c-0.254-0.095-0.529-0.167-0.818-0.201c-0.013,0-0.026-0.002-0.039-0.002c-0.371-0.043-0.748-0.064-1.124-0.064 c-4.383,0-7.941,3.053-7.941,6.819c0,0.832,0.198,1.609,0.547,2.311c-1.137-1.332-1.82-2.947-1.82-4.705 C6.202,12.503,10.027,13.845,14.727,13.845z M14.447,17.617c-0.649,0-1.172-0.524-1.172-1.172c0-0.649,0.524-1.172,1.172-1.172 c0.649,0,1.172,0.524,1.172,1.172C15.62,17.093,15.096,17.617,14.447,17.617z M19.337,17.617c-0.649,0-1.172-0.524-1.172-1.172 c0-0.649,0.524-1.172,1.172-1.172c0.649,0,1.172,0.524,1.172,1.172C20.51,17.093,19.986,17.617,19.337,17.617z M22.516,16.192 c0-0.006,0-0.012,0-0.017c-0.001-0.004-0.002-0.008-0.002-0.012c-0.254-3.137-3.351-5.605-7.163-5.605 c-3.95,0-7.156,2.651-7.156,5.922s3.206,5.922,7.156,5.922c0.879,0,1.724-0.129,2.524-0.369c0.289,0.166,1.353,0.781,1.705,0.977 c0.045,0.025,0.094,0.037,0.144,0.037c0.105,0,0.205-0.042,0.278-0.115c0.096-0.091,0.139-0.223,0.116-0.352 c0,0-0.34-1.246-0.522-1.914C21.562,19.612,22.516,17.986,22.516,16.192z"></path></svg>';
                                                }}
                                            />
                                        </div>
                                    )}
                                    
                                    {/* GroupMe icon */}
                                    {(link.type === 'groupme' || link.icon === 'groupme') && (
                                        <div className="external-link-icon" style={{ backgroundColor: '#00AFF0' }}>
                                            <img 
                                                src="https://web.groupme.com/favicon-32x32.png" 
                                                width="16" 
                                                height="16" 
                                                alt="GroupMe" 
                                                onError={(e) => {
                                                    e.target.onerror = null;
                                                    e.target.parentNode.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="#FFFFFF"><path d="M12,2C6.477,2,2,6.477,2,12c0,5.523,4.477,10,10,10s10-4.477,10-10C22,6.477,17.523,2,12,2z M12,5.5 c1.381,0,2.5,1.119,2.5,2.5c0,1.381-1.119,2.5-2.5,2.5c-1.381,0-2.5-1.119-2.5-2.5C9.5,6.619,10.619,5.5,12,5.5z M12,19.2 c-2.733,0-5.153-1.392-6.574-3.5C5.699,13.189,10,12.1,12,12.1c2,0,6.301,1.089,6.574,3.6C17.153,17.808,14.733,19.2,12,19.2z"></path></svg>';
                                                }}
                                            />
                                        </div>
                                    )}
                                    
                                    {/* Default/Other icon */}
                                    {(link.type === 'other' || (!link.type && !link.icon) || (link.type !== 'discord' && link.type !== 'telegram' && link.type !== 'wechat' && link.type !== 'groupme')) && (
                                        <div className="external-link-icon">
                                            <LinkIcon style={{ fontSize: '16px', color: '#1d9bf0' }} />
                                        </div>
                                    )}
                                    
                                    <span>{link.name}</span>
                                </a>
                                {room?.createdBy?._id === currentUser?._id && (
                                    <IconButton 
                                        size="small" 
                                        onClick={() => handleDeleteExternalLink(link._id || link.id)}
                                        sx={{ 
                                            position: 'absolute',
                                            right: '3px',
                                            top: '50%',
                                            transform: 'translateY(-50%)',
                                            padding: '2px', 
                                            color: '#a0a0a0',
                                            '&:hover': { color: '#ff4040', backgroundColor: 'rgba(255,0,0,0.05)' } 
                                        }}
                                    >
                                        <CloseIcon fontSize="small" />
                                    </IconButton>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            </div>
            
            {/* Toggle button with improved positioning */}
            <button
                onClick={() => setShowMembers(!showMembers)}
                className={`sidebar-toggle-button ${showMembers ? 'visible' : ''}`}
                style={{
                    position: 'fixed',
                    right: showMembers ? '280px' : '0px', // When sidebar is visible, button is on left side of sidebar
                    top: '50%',
                    transform: 'translateY(-50%)',
                    zIndex: 1600,
                    backgroundColor: '#1d9bf0', // Twitter blue to match other UI elements
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px 0 0 4px', // Always square, with rounded corners only on left side
                    width: '40px',
                    height: '40px',
                    cursor: 'pointer',
                    boxShadow: '0 2px 10px rgba(0, 0, 0, 0.2)',
                    transition: 'right 0.3s ease-in-out, transform 0.2s ease',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 0
                }}
                onMouseOver={(e) => e.currentTarget.style.transform = 'translateY(-50%) scale(1.05)'}
                onMouseOut={(e) => e.currentTarget.style.transform = 'translateY(-50%)'}
            >
                {showMembers ? <ArrowRightIcon /> : <ArrowLeftIcon />}
            </button>
            
            {/* Main chat UI with updated class for sidebar visibility */}
            <Container maxWidth="md" className={`chat-room-container ${isDashboardCollapsed ? 'dashboard-collapsed' : ''} ${showMembers ? 'sidebar-visible' : ''}`}>
                <div className="main-chat-content">
                    {/* Chat header */}
                    <AppBar position="fixed" color="default" elevation={1} className="chat-room-header">
                        <Toolbar>
                            <IconButton edge="start" color="inherit" onClick={() => navigate(`/pods/${podType}`)} sx={{ mr: 2 }}>
                                <ArrowBackIcon />
                            </IconButton>
                            <Box sx={{ flexGrow: 1 }}>
                                <Typography variant="h6" component="div">
                                    {room?.name || 'Chat Room'}
                                </Typography>
                                <Typography variant="caption" color="text.secondary">
                                    {room?.members?.length || 0} members
                                </Typography>
                            </Box>
                        </Toolbar>
                    </AppBar>
                    
                    {/* Chat Content */}
                    <Box className="chat-content-container">
                        <Paper 
                            elevation={0} 
                            className="messages-container"
                        >
                            {messages.length === 0 ? (
                                <Box className="empty-chat-message">
                                    <ChatIcon sx={{ fontSize: 80 }} />
                                    <Typography variant="h5" gutterBottom>
                                        No messages yet
                                    </Typography>
                                    <Typography variant="body1" color="text.secondary">
                                        Be the first to start the conversation!
                                    </Typography>
                                </Box>
                            ) : (
                                <List>
                                    {messages.map((msg) => {
                                        // Check if msg or msg.userId is undefined or null
                                        if (!msg) {
                                            console.warn('Encountered undefined message in messages array');
                                            return null; // Skip rendering this item
                                        }
                                        
                                        // Safely handle userId which could be an object, string, or undefined
                                        const isCurrentUser = msg.userId 
                                            ? (typeof msg.userId === 'object'
                                                ? msg.userId?._id === currentUser?._id 
                                                : msg.userId === currentUser?._id)
                                            : (msg.user_id === currentUser?._id); // Fallback to check user_id field
                                        
                                        // Get username with multiple fallbacks
                                        const username = 
                                            (msg.userId && typeof msg.userId === 'object' && msg.userId.username) ||
                                            msg.username || 
                                            'Unknown User';
                                        
                                        // Get profile picture with multiple fallbacks
                                        const profilePicture = 
                                            (msg.userId && typeof msg.userId === 'object' && msg.userId.profilePicture) ||
                                            msg.profile_picture || 
                                            null;
                                        
                                        // Get message content with fallbacks
                                        const messageContent = msg.content || msg.text || '';
                                        
                                        // Get message type with fallback
                                        const messageType = msg.messageType || msg.message_type || 'text';
                                        
                                        // Get message timestamp with fallbacks
                                        const messageTime = msg.createdAt || msg.created_at || new Date();
                                        
                                        return (
                                            <ListItem 
                                                key={msg._id || msg.id || Date.now() + Math.random()}
                                                className={`message-item ${isCurrentUser ? 'sent' : 'received'}`}
                                            >
                                                <ListItemAvatar className="message-avatar">
                                                    <div className="message-user">{username}</div>
                                                    <Avatar 
                                                        sx={{ bgcolor: getAvatarColor(profilePicture || 'default') }}
                                                    >
                                                        {username.charAt(0).toUpperCase()}
                                                    </Avatar>
                                                </ListItemAvatar>
                                                
                                                <div className="message-content-wrapper">
                                                    {/* Text message */}
                                                    {messageType === 'text' && (
                                                        <div className={`message-bubble ${isCurrentUser ? 'sent' : 'received'}`}>
                                                            <p className="message-text">{messageContent}</p>
                                                        </div>
                                                    )}
                                                    
                                                    {/* Image message */}
                                                    {messageType === 'image' && (
                                                        <div className={`message-image-container ${isCurrentUser ? 'sent' : 'received'}`}>
                                                            <img 
                                                                src={messageContent}
                                                                alt="Shared image" 
                                                                className="message-image"
                                                                onClick={() => window.open(messageContent, '_blank')}
                                                            />
                                                        </div>
                                                    )}
                                                    
                                                    <div className={`message-time ${isCurrentUser ? 'message-sent-time' : 'message-received-time'}`}>
                                                        {formatDistanceToNow(new Date(messageTime), { addSuffix: true })}
                                                    </div>
                                                </div>
                                            </ListItem>
                                        );
                                    })}
                                    <div ref={messagesEndRef} />
                                </List>
                            )}
                        </Paper>
                    </Box>
                </div>
                
                {/* Message input */}
                <Paper 
                    component="form" 
                    onSubmit={handleSendMessage}
                    className="message-input-container"
                >
                    <IconButton 
                        onClick={toggleEmojiPicker} 
                        className="emoji-button"
                        aria-label="Insert emoji"
                    >
                        <EmojiIcon />
                    </IconButton>
                    
                    <input
                        type="file"
                        accept="image/*"
                        style={{ display: 'none' }}
                        onChange={handleFileSelect}
                        ref={fileInputRef}
                    />
                    
                    <IconButton 
                        onClick={() => fileInputRef.current.click()} 
                        className="attach-button"
                        disabled={isUploading}
                    >
                        {isUploading ? <CircularProgress size={24} /> : <AttachFileIcon />}
                    </IconButton>
                    
                    {previewUrl && (
                        <Box className="file-preview">
                            <img src={previewUrl} alt="Preview" className="preview-image" />
                            <IconButton 
                                size="small" 
                                className="remove-preview" 
                                onClick={() => {
                                    setSelectedFile(null);
                                    setPreviewUrl('');
                                }}
                            >
                                &times;
                            </IconButton>
                        </Box>
                    )}
                    
                    <TextField
                        fullWidth
                        placeholder={selectedFile ? "Add a caption..." : "Type a message..."}
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        variant="standard"
                        InputProps={{
                            disableUnderline: true,
                        }}
                        className="message-input"
                    />
                    
                    <IconButton 
                        color="primary" 
                        type="submit"
                        disabled={(!message.trim() && !selectedFile) || !connected || isUploading}
                        className="send-button"
                    >
                        <SendIcon />
                    </IconButton>
                </Paper>
            </Container>

            {/* Emoji picker */}
            {showEmojiPicker && (
                <div className="emoji-picker-wrapper" ref={emojiPickerRef}>
                    <div className="emoji-picker-container">
                        <EmojiPicker 
                            onEmojiClick={onEmojiClick}
                            searchDisabled={false}
                            skinTonesDisabled={true}
                            width={350}
                            height={450}
                        />
                    </div>
                </div>
            )}
        </>
    );
};

export default ChatRoom; 