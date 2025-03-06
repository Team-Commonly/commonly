import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { 
    Container, Typography, Box, Paper, TextField, IconButton, 
    Avatar, Divider, List, ListItem, ListItemText, ListItemAvatar,
    Button, CircularProgress, AppBar, Toolbar, Badge, Chip, FormControlLabel, Switch
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
import { getAvatarColor } from '../utils/avatarUtils';
import axios from 'axios';
import EmojiPicker from 'emoji-picker-react';
import './ChatRoom.css';

const ChatRoom = () => {
    const { currentUser } = useAuth();
    const { socket, connected, pgAvailable, joinPod, leavePod, sendMessage } = useSocket();
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
    
    // Fetch pod details and messages
    useEffect(() => {
        const fetchPodAndMessages = async () => {
            setLoading(true);
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

                // Fetch pod details - include podType in the URL
                const podResponse = await axios.get(`/api/pods/${podType}/${roomId}`, authHeaders);
                
                if (!podResponse.data) {
                    throw new Error('Pod not found');
                }
                
                setRoom(podResponse.data);
                
                // Fetch messages
                const messagesResponse = await axios.get(`/api/messages/${roomId}`, authHeaders);
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
    }, [roomId, podType]);
    
    // Join pod room when socket connects
    useEffect(() => {
        if (connected && roomId && !error) {
            joinPod(roomId);
            
            // Listen for new messages
            socket.on('newMessage', (message) => {
                setMessages(prevMessages => [...prevMessages, message]);
            });
            
            // Clean up
            return () => {
                leavePod(roomId);
                socket.off('newMessage');
            };
        }
    }, [connected, roomId, socket, joinPod, leavePod, error]);
    
    // Scroll to bottom when messages change
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);
    
    const handleSendMessage = async (e) => {
        e.preventDefault();
        if (!message.trim()) return;
        
        // Create a new message object
        const newMessage = {
            id: Date.now(), // temporary ID
            text: message,
            podId: roomId,
            userId: {
                _id: currentUser?._id,
                username: currentUser?.username,
                profilePicture: currentUser?.profilePicture
            },
            createdAt: new Date()
        };
        
        // Add message to the UI immediately (optimistic update)
        setMessages([...messages, newMessage]);
        setMessage('');
        
        try {
            // Get the authentication token
            const token = localStorage.getItem('token');
            if (!token) {
                setError('Authentication required. Please log in again.');
                return;
            }

            // Send message via socket
            sendMessage(roomId, message);
            
            // Also send to API for persistence
            await axios.post(`/api/messages/${roomId}`, {
                text: message
            }, {
                headers: { 
                    'Authorization': `Bearer ${token}` 
                }
            });
        } catch (err) {
            console.error('Failed to send message:', err);
            setError('Failed to send message. Please try again.');
            // Remove the message from the UI if it fails
            setMessages(messages.filter(m => m.id !== newMessage.id));
        }
    };
    
    const onEmojiClick = (emojiData) => {
        setMessage(prevMessage => prevMessage + emojiData.emoji);
    };
    
    const handleBack = () => {
        navigate(`/pods/${podType}`);
    };
    
    // Display offline notification with reconnect button
    const handleReconnect = () => {
        // Get the socket instance from context
        if (socket) {
            console.log('Attempting to reconnect...');
            socket.connect();
        }
    };
    
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
                <Button variant="contained" onClick={handleBack} sx={{ mt: 2 }}>
                    Back to Rooms
                </Button>
            </Box>
        );
    }
    
    return (
        <Container maxWidth="md" className="chat-room-container">
            <AppBar position="fixed" color="default" elevation={1} className="chat-room-header">
                <Toolbar>
                    <IconButton edge="start" color="inherit" onClick={handleBack} sx={{ mr: 2 }}>
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
                                            src={member.profilePicture}
                                            sx={{ bgcolor: getAvatarColor(member.username || '') }}
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
                            {messages.map((msg) => (
                                <ListItem 
                                    key={msg._id || msg.id}
                                    className={`message-item ${msg.userId._id === currentUser?._id ? 'sent' : 'received'}`}
                                >
                                    <ListItemAvatar className="message-avatar">
                                        <Avatar 
                                            src={msg.userId.profilePicture}
                                            sx={{ bgcolor: getAvatarColor(msg.userId.username || '') }}
                                        >
                                            {msg.userId.username?.charAt(0).toUpperCase()}
                                        </Avatar>
                                    </ListItemAvatar>
                                    <Box className="message-content-wrapper">
                                        <Paper 
                                            elevation={1}
                                            className={`message-bubble ${msg.userId._id === currentUser?._id ? 'sent' : 'received'}`}
                                        >
                                            <Typography variant="body1">{msg.text}</Typography>
                                        </Paper>
                                        <Box className="message-meta">
                                            <Typography variant="caption" className="message-username">
                                                {msg.userId.username}
                                            </Typography>
                                            <Typography variant="caption" className="message-time">
                                                {formatDistanceToNow(new Date(msg.createdAt))} ago
                                            </Typography>
                                        </Box>
                                    </Box>
                                </ListItem>
                            ))}
                            <div ref={messagesEndRef} />
                        </List>
                    )}
                </Paper>
            </Box>
            
            <Paper 
                component="form" 
                onSubmit={handleSendMessage}
                className="message-input-container"
            >
                <IconButton onClick={() => setShowEmojiPicker(!showEmojiPicker)} className="emoji-button">
                    <EmojiIcon />
                </IconButton>
                <IconButton className="attach-button">
                    <AttachFileIcon />
                </IconButton>
                <TextField
                    fullWidth
                    placeholder="Type a message..."
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
                    disabled={!message.trim() || !connected}
                    className="send-button"
                >
                    <SendIcon />
                </IconButton>
                
                {showEmojiPicker && (
                    <Box className="emoji-picker-container">
                        <EmojiPicker onEmojiClick={onEmojiClick} />
                    </Box>
                )}
            </Paper>
            
            {!connected && (
                <Paper className="offline-notification">
                    <Typography variant="body2">
                        You are currently offline. Messages will be sent when you reconnect.
                    </Typography>
                    <Button 
                        variant="contained" 
                        color="primary" 
                        size="small"
                        onClick={handleReconnect}
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