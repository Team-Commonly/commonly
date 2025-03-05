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
    People as PeopleIcon
} from '@mui/icons-material';
import { formatDistanceToNow } from 'date-fns';
import { useAppContext } from '../context/AppContext';
import { useSocketContext } from '../context/SocketContext';
import { getAvatarColor } from '../utils/avatarUtils';
import axios from 'axios';
import EmojiPicker from 'emoji-picker-react';
import { useAuth } from '../context/AuthContext';
import './ChatRoom.css';

const ChatRoom = () => {
    const { currentUser } = useAppContext();
    const { socket, connected, pgAvailable, joinPod, leavePod, sendMessage } = useSocketContext();
    const { podType, roomId } = useParams();
    const navigate = useNavigate();
    const { podId } = useParams();
    const { pod } = useAuth();
    const [messages, setMessages] = useState([]);
    const [newMessage, setNewMessage] = useState('');
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
                // Fetch pod details
                const podResponse = await axios.get(`/api/pods/${podId}`);
                
                setPod(podResponse.data);
                
                // Fetch messages
                const messagesResponse = await axios.get(`/api/messages/${podId}`);
                
                setMessages(messagesResponse.data.reverse()); // Reverse to show oldest first
                setError(null);
            } catch (err) {
                console.error('Error fetching pod data:', err);
                setError('Failed to load chat room. Please try again.');
            } finally {
                setLoading(false);
            }
        };
        
        if (podId) {
            fetchPodAndMessages();
        }
    }, [podId]);
    
    // Join pod room when socket connects
    useEffect(() => {
        if (connected && podId) {
            joinPod(podId);
            
            // Listen for new messages
            socket.on('newMessage', (message) => {
                setMessages(prevMessages => [...prevMessages, message]);
            });
            
            // Clean up
            return () => {
                leavePod(podId);
                socket.off('newMessage');
            };
        }
    }, [connected, podId, socket, joinPod, leavePod]);
    
    // Listen for new messages
    useEffect(() => {
        if (socket) {
            const handleNewMessage = (newMessage) => {
                if (newMessage.podId === roomId) {
                    setMessages(prevMessages => [...prevMessages, newMessage]);
                }
            };
            
            socket.on('new-message', handleNewMessage);
            
            return () => {
                socket.off('new-message', handleNewMessage);
            };
        }
    }, [socket, roomId]);
    
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
                _id: currentUser._id,
                username: currentUser.username,
                profilePicture: currentUser.profilePicture
            },
            createdAt: new Date()
        };
        
        // Add message to the UI immediately (optimistic update)
        setMessages([...messages, newMessage]);
        setMessage('');
        
        try {
            // Send message via socket
            sendMessage(roomId, message);
            
            // Also send to API for persistence
            await axios.post(`/api/messages/${roomId}`, {
                text: message
            }, {
                headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
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
        <Container maxWidth="md" sx={{ py: 2, mt: 8, height: 'calc(100vh - 100px)', display: 'flex', flexDirection: 'column' }}>
            <AppBar position="fixed" color="default" elevation={1} sx={{ top: 0, bottom: 'auto' }}>
                <Toolbar>
                    <IconButton edge="start" color="inherit" onClick={handleBack} sx={{ mr: 2 }}>
                        <ArrowBackIcon />
                    </IconButton>
                    <Box sx={{ flexGrow: 1 }}>
                        <Typography variant="h6" component="div">
                            {room?.name}
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
            
            <Box sx={{ display: 'flex', flex: 1, position: 'relative' }}>
                {/* Members sidebar */}
                {showMembers && (
                    <Paper 
                        elevation={3} 
                        sx={{ 
                            width: 250, 
                            p: 2, 
                            position: 'absolute', 
                            right: 0, 
                            top: 0, 
                            bottom: 0, 
                            zIndex: 10,
                            overflowY: 'auto',
                            display: { xs: 'none', sm: 'block' }
                        }}
                    >
                        <Typography variant="h6" sx={{ mb: 2 }}>Members</Typography>
                        <List>
                            {room?.members?.map(member => (
                                <ListItem key={member._id}>
                                    <ListItemAvatar>
                                        <Avatar sx={{ bgcolor: getAvatarColor(member.profilePicture) }}>
                                            {member.username.charAt(0).toUpperCase()}
                                        </Avatar>
                                    </ListItemAvatar>
                                    <ListItemText 
                                        primary={member.username} 
                                        secondary={member._id === room.createdBy._id ? 'Creator' : ''}
                                    />
                                </ListItem>
                            ))}
                        </List>
                    </Paper>
                )}
                
                {/* Chat messages */}
                <Paper 
                    elevation={0} 
                    sx={{ 
                        flex: 1, 
                        overflow: 'auto', 
                        p: 2, 
                        mb: 2,
                        bgcolor: 'background.default'
                    }}
                >
                    {messages.length === 0 ? (
                        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
                            <Typography color="text.secondary">No messages yet. Start the conversation!</Typography>
                        </Box>
                    ) : (
                        <List>
                            {messages.map((msg) => (
                                <ListItem 
                                    key={msg._id || msg.id}
                                    alignItems="flex-start"
                                    sx={{ 
                                        mb: 1,
                                        flexDirection: msg.userId._id === currentUser?._id ? 'row-reverse' : 'row'
                                    }}
                                >
                                    <ListItemAvatar>
                                        <Avatar sx={{ bgcolor: getAvatarColor(msg.userId.profilePicture) }}>
                                            {msg.userId.username.charAt(0).toUpperCase()}
                                        </Avatar>
                                    </ListItemAvatar>
                                    <Box 
                                        sx={{ 
                                            display: 'flex', 
                                            flexDirection: 'column',
                                            alignItems: msg.userId._id === currentUser?._id ? 'flex-end' : 'flex-start',
                                            maxWidth: '70%'
                                        }}
                                    >
                                        <Paper 
                                            elevation={1}
                                            sx={{ 
                                                p: 2, 
                                                borderRadius: 2,
                                                bgcolor: msg.userId._id === currentUser?._id ? 'primary.light' : 'background.paper',
                                                color: msg.userId._id === currentUser?._id ? 'primary.contrastText' : 'text.primary'
                                            }}
                                        >
                                            <Typography variant="body1">{msg.text}</Typography>
                                        </Paper>
                                        <Box sx={{ display: 'flex', mt: 0.5, gap: 1 }}>
                                            <Typography variant="caption" color="text.secondary">
                                                {msg.userId.username}
                                            </Typography>
                                            <Typography variant="caption" color="text.secondary">
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
                sx={{ 
                    p: 1, 
                    display: 'flex', 
                    alignItems: 'center',
                    position: 'relative'
                }}
            >
                <IconButton onClick={() => setShowEmojiPicker(!showEmojiPicker)}>
                    <EmojiIcon />
                </IconButton>
                <IconButton>
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
                    sx={{ mx: 1 }}
                />
                <IconButton 
                    color="primary" 
                    type="submit"
                    disabled={!message.trim() || !connected}
                >
                    <SendIcon />
                </IconButton>
                
                {showEmojiPicker && (
                    <Box 
                        sx={{ 
                            position: 'absolute', 
                            bottom: '100%', 
                            right: 0,
                            zIndex: 1000,
                            boxShadow: 3,
                            borderRadius: 1,
                            mb: 1
                        }}
                    >
                        <EmojiPicker onEmojiClick={onEmojiClick} />
                    </Box>
                )}
            </Paper>
            
            {!connected && (
                <Paper 
                    sx={{ 
                        p: 1, 
                        mt: 1, 
                        bgcolor: 'warning.light', 
                        color: 'warning.contrastText',
                        textAlign: 'center'
                    }}
                >
                    <Typography variant="body2">
                        You are currently offline. Messages will be sent when you reconnect.
                    </Typography>
                </Paper>
            )}
        </Container>
    );
};

export default ChatRoom; 