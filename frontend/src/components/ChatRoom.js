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
            {/* Sidebar - rendered completely outside the main container */}
            <div 
                className={`members-sidebar ${!showMembers ? 'hidden' : ''}`}
                style={{
                    position: 'fixed',
                    top: 0,
                    right: 0,
                    width: '280px',
                    height: '100vh',
                    backgroundColor: '#202636',
                    color: '#fff',
                    zIndex: 1500,
                    boxShadow: '-5px 0 20px rgba(0, 0, 0, 0.5)',
                    overflowY: 'auto',
                    transition: 'transform 0.3s ease-in-out',
                    transform: showMembers ? 'translateX(0)' : 'translateX(100%)'
                }}
            >
                {/* Sidebar content */}
                <div className="sidebar-section">
                    <div className="sidebar-section-title">
                        <div className="members-count">
                            <PeopleIcon /> Members {room?.members?.length || 0}
                        </div>
                    </div>
                    <div className="sidebar-section-content">
                        <Box sx={{ mb: 2, display: 'flex', alignItems: 'center' }}>
                            <TextField 
                                size="small"
                                placeholder="Search members..."
                                variant="outlined"
                                fullWidth
                                InputProps={{
                                    startAdornment: <SearchIcon fontSize="small" sx={{ mr: 1, color: '#adb5bd' }} />
                                }}
                                sx={{ 
                                    bgcolor: 'rgba(255,255,255,0.1)', 
                                    borderRadius: '4px',
                                    '& .MuiOutlinedInput-root': {
                                        color: '#fff',
                                        '& fieldset': { border: 'none' },
                                        borderRadius: '4px' // Ensuring consistent border radius
                                    }
                                }}
                            />
                        </Box>
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
                                <div className="sidebar-member-status"></div>
                            </div>
                        ))}
                    </div>
                </div>
                
                {/* Announcements section */}
                <div className="sidebar-section">
                    <div className="sidebar-section-title">
                        <span><AnnouncementIcon style={{ marginRight: '8px', fontSize: '16px' }} /> Announcements</span>
                        <IconButton 
                            size="small" 
                            onClick={() => room?.createdBy?._id === currentUser?._id ? setIsEditingAnnouncement(!isEditingAnnouncement) : null}
                            sx={{ 
                                padding: '4px',
                                color: room?.createdBy?._id === currentUser?._id ? 'white' : 'rgba(255,255,255,0.5)', 
                                '&.Mui-disabled': {
                                    color: 'rgba(255,255,255,0.3)',
                                },
                                cursor: room?.createdBy?._id === currentUser?._id ? 'pointer' : 'not-allowed'
                            }}
                        >
                            {isEditingAnnouncement ? <CloseIcon fontSize="small" /> : <ChevronRightIcon />}
                        </IconButton>
                    </div>
                    <div className="sidebar-section-content">
                        {isEditingAnnouncement && room?.createdBy?._id === currentUser?._id && (
                            <Box sx={{ mb: 2, p: 1, bgcolor: 'rgba(255,255,255,0.05)', borderRadius: '4px' }}>
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
                                            color: '#fff',
                                            '& fieldset': { borderColor: 'rgba(255,255,255,0.2)' }
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
                                            color: '#fff',
                                            '& fieldset': { borderColor: 'rgba(255,255,255,0.2)' }
                                        }
                                    }}
                                />
                                {error && (
                                    <Box sx={{ 
                                        p: 1, 
                                        mb: 1, 
                                        bgcolor: 'rgba(255,0,0,0.1)', 
                                        borderRadius: '4px',
                                        color: '#ff6b6b',
                                        fontSize: '12px',
                                        display: 'flex',
                                        alignItems: 'center'
                                    }}>
                                        <span>{error}</span>
                                        <IconButton 
                                            size="small" 
                                            sx={{ ml: 'auto', color: '#ff6b6b', p: '2px' }}
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
                                                color: 'rgba(255,255,255,0.5)',
                                                '&:hover': { color: '#ff6b6b' } 
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
                        <span><LinkIcon style={{ marginRight: '8px', fontSize: '16px' }} /> External Links</span>
                        <IconButton 
                            size="small" 
                            onClick={() => room?.createdBy?._id === currentUser?._id ? setIsEditingLinks(!isEditingLinks) : null}
                            sx={{ 
                                padding: '4px',
                                color: room?.createdBy?._id === currentUser?._id ? 'white' : 'rgba(255,255,255,0.5)', 
                                '&.Mui-disabled': {
                                    color: 'rgba(255,255,255,0.3)',
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
                            <Box sx={{ mb: 2, p: 1, bgcolor: 'rgba(255,255,255,0.05)', borderRadius: '4px' }}>
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
                                            color: '#fff',
                                            '& fieldset': { borderColor: 'rgba(255,255,255,0.2)' }
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
                                            color: '#fff',
                                            '& fieldset': { borderColor: 'rgba(255,255,255,0.2)' }
                                        },
                                        '& .MuiSelect-icon': {
                                            color: 'rgba(255,255,255,0.7)'
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
                                                color: '#fff',
                                                '& fieldset': { borderColor: 'rgba(255,255,255,0.2)' }
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
                                                    borderColor: 'rgba(255,255,255,0.3)',
                                                    color: '#fff',
                                                    '&:hover': { borderColor: 'rgba(255,255,255,0.5)' }
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
                                        bgcolor: 'rgba(255,0,0,0.1)', 
                                        borderRadius: '4px',
                                        color: '#ff6b6b',
                                        fontSize: '12px',
                                        display: 'flex',
                                        alignItems: 'center'
                                    }}>
                                        <span>{error}</span>
                                        <IconButton 
                                            size="small" 
                                            sx={{ ml: 'auto', color: '#ff6b6b', p: '2px' }}
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
                                    {(link.type === 'discord' || link.icon === 'discord') && (
                                        <img src="https://assets-global.website-files.com/6257adef93867e50d84d30e2/636e0a6ca814282eca7172c6_icon_clyde_white_RGB.svg" width="18" height="18" alt="Discord" style={{ marginRight: '10px' }} />
                                    )}
                                    {(link.type === 'telegram' || link.icon === 'telegram') && (
                                        <img src="https://telegram.org/img/t_logo.svg" width="18" height="18" alt="Telegram" style={{ marginRight: '10px' }} />
                                    )}
                                    {(link.type === 'wechat' || link.icon === 'wechat') && (
                                        <img src="https://res.wx.qq.com/a/wx_fed/assets/res/NTI4MWU5.ico" width="18" height="18" alt="WeChat" style={{ marginRight: '10px' }} />
                                    )}
                                    {(link.type === 'groupme' || link.icon === 'groupme') && (
                                        <img src="https://groupme.com/favicon.ico" width="18" height="18" alt="GroupMe" style={{ marginRight: '10px' }} />
                                    )}
                                    {(link.type === 'other' || !link.type) && (
                                        <LinkIcon style={{ marginRight: '10px', fontSize: '18px' }} />
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
                                            color: 'rgba(255,255,255,0.5)',
                                            '&:hover': { color: '#ff6b6b' } 
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
            
            {/* Toggle button - also rendered outside the main container */}
            <button
                onClick={() => setShowMembers(!showMembers)}
                style={{
                    position: 'fixed',
                    right: showMembers ? '280px' : '0px',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    zIndex: 1600,
                    backgroundColor: '#202636',
                    color: 'white',
                    border: 'none',
                    borderRadius: showMembers ? '50%' : '4px 0 0 4px',
                    width: '50px',
                    height: '50px',
                    cursor: 'pointer',
                    boxShadow: '0 2px 10px rgba(0, 0, 0, 0.5)',
                    transition: 'right 0.3s ease-in-out, transform 0.2s ease',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '18px'
                }}
                onMouseOver={(e) => e.currentTarget.style.transform = 'translateY(-50%) scale(1.05)'}
                onMouseOut={(e) => e.currentTarget.style.transform = 'translateY(-50%)'}
            >
                {showMembers ? '→' : '←'}
            </button>
            
            {/* Overlay - also rendered outside */}
            {showMembers && (
                <div 
                    style={{
                        position: 'fixed',
                        top: 0,
                        left: 0,
                        right: '280px', // Changed from 'right: 0' to leave space for the sidebar
                        bottom: 0,
                        backgroundColor: 'rgba(0, 0, 0, 0.5)',
                        zIndex: 1400
                    }}
                    onClick={() => setShowMembers(false)}
                />
            )}
            
            {/* Main chat UI */}
            <Container maxWidth="md" className={`chat-room-container ${isDashboardCollapsed ? 'dashboard-collapsed' : ''}`}>
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
                </Box>
            </Container>
        </>
    );
};

export default ChatRoom; 