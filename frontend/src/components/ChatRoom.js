import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { 
    Container, Typography, Box, Paper, TextField, IconButton, 
    Avatar, Divider, List, ListItem, ListItemText, ListItemAvatar,
    Button, CircularProgress, AppBar, Toolbar, Badge, Chip, FormControlLabel, Switch,
    Portal
} from '@mui/material';
import { 
    Send as SendIcon, 
    ArrowBack as ArrowBackIcon,
    EmojiEmotions as EmojiIcon,
    AttachFile as AttachFileIcon,
    People as PeopleIcon,
    Chat as ChatIcon
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
    const [showMembers, setShowMembers] = useState(false);
    const messagesEndRef = useRef(null);
    const [selectedFile, setSelectedFile] = useState(null);
    const [previewUrl, setPreviewUrl] = useState('');
    const [isUploading, setIsUploading] = useState(false);
    const fileInputRef = useRef(null);
    const emojiPickerRef = useRef(null);
    
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
    
    if (loading) {
        return (
            <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
                <CircularProgress />
            </Box>
        );
    }
    
    if (error) {
        return (
            <Box sx={{ p: 3, textAlign: 'center' }}>
                <Typography color="error">{error}</Typography>
                <Button variant="contained" onClick={() => navigate(`/pods/${podType}`)} sx={{ mt: 2 }}>
                    Back to Rooms
                </Button>
            </Box>
        );
    }
    
    return (
        <Container maxWidth="md" className={`chat-room-container ${isDashboardCollapsed ? 'dashboard-collapsed' : ''}`}>
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
                    <IconButton color="inherit" onClick={() => setShowMembers(!showMembers)}>
                        <Badge badgeContent={room?.members?.length || 0} color="primary">
                            <PeopleIcon />
                        </Badge>
                    </IconButton>
                </Toolbar>
            </AppBar>
            
            <Box className="chat-content-container">
                {/* Members sidebar */}
                {showMembers && (
                    <Paper 
                        elevation={3} 
                        className="members-sidebar"
                    >
                        <Typography variant="h6" sx={{ mb: 2 }}>Members</Typography>
                        <List>
                            {room?.members?.map(member => (
                                <ListItem key={member._id}>
                                    <ListItemAvatar>
                                        <Avatar 
                                            sx={{ bgcolor: getAvatarColor(member.profilePicture || 'default') }}
                                        >
                                            {member.username?.charAt(0).toUpperCase()}
                                        </Avatar>
                                    </ListItemAvatar>
                                    <ListItemText 
                                        primary={member.username} 
                                        secondary={member._id === room.createdBy?._id ? 'Creator' : ''}
                                    />
                                </ListItem>
                            ))}
                        </List>
                    </Paper>
                )}
                
                {/* Chat messages */}
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
                                            <Avatar 
                                                sx={{ bgcolor: getAvatarColor(profilePicture || 'default') }}
                                            >
                                                {username.charAt(0).toUpperCase()}
                                            </Avatar>
                                        </ListItemAvatar>
                                        
                                        <div className="message-content-wrapper">
                                            {!isCurrentUser && <div className="message-user">{username}</div>}
                                            
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
                    
                    {/* Render emoji picker in a fixed position above the input field */}
                    {showEmojiPicker && (
                        <div className="emoji-picker-wrapper">
                            <Box 
                                className="emoji-picker-container"
                                ref={emojiPickerRef}
                            >
                                <Box 
                                    sx={{ 
                                        display: 'flex', 
                                        justifyContent: 'space-between', 
                                        alignItems: 'center',
                                        p: 1,
                                        borderBottom: '1px solid #eee'
                                    }}
                                >
                                    <Typography variant="subtitle2">
                                        Emoji Picker
                                    </Typography>
                                    <IconButton 
                                        size="small"
                                        onClick={() => setShowEmojiPicker(false)}
                                        sx={{
                                            backgroundColor: 'rgba(0,0,0,0.05)',
                                            padding: '4px',
                                            width: '24px',
                                            height: '24px'
                                        }}
                                    >
                                        &times;
                                    </IconButton>
                                </Box>
                                <Box sx={{ flexGrow: 1, overflow: 'hidden' }}>
                                    <EmojiPicker 
                                        onEmojiClick={onEmojiClick}
                                        lazyLoadEmojis={true}
                                        emojiStyle="native"
                                        width="100%"
                                        height="100%"
                                        searchDisabled={false}
                                        skinTonesDisabled={true}
                                        previewConfig={{ showPreview: false }}
                                        style={{ transform: 'none', scale: 1 }}
                                        emojiVersion="5.0"
                                        categories={[
                                            {
                                                name: "Smileys & People",
                                                category: "smileys_people"
                                            },
                                            {
                                                name: "Animals & Nature",
                                                category: "animals_nature"
                                            },
                                            {
                                                name: "Food & Drink",
                                                category: "food_drink"
                                            },
                                            {
                                                name: "Activities",
                                                category: "activities"
                                            },
                                            {
                                                name: "Travel & Places",
                                                category: "travel_places"
                                            },
                                            {
                                                name: "Objects",
                                                category: "objects"
                                            },
                                            {
                                                name: "Symbols",
                                                category: "symbols"
                                            },
                                            {
                                                name: "Flags",
                                                category: "flags"
                                            }
                                        ]}
                                    />
                                </Box>
                            </Box>
                        </div>
                    )}
                    
                    {/* Message input at bottom of messages container */}
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
                </Paper>
            </Box>
            
            {!connected && (
                <Paper className="offline-notification">
                    <Typography variant="body2">
                        You are currently offline. Messages will be sent when you reconnect.
                    </Typography>
                    <Button 
                        variant="contained" 
                        color="primary" 
                        size="small"
                        onClick={() => socket.connect()}
                        sx={{ mt: 1 }}
                    >
                        Reconnect
                    </Button>
                </Paper>
            )}
        </Container>
    );
};

export default ChatRoom; 