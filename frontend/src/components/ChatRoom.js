/* eslint-disable max-len */
import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
    Container, Typography, Box, Paper, TextField, IconButton, Alert,
    Avatar, List, ListItem, ListItemAvatar,
    Button, CircularProgress, AppBar, Toolbar, MenuItem, Tooltip, useMediaQuery, useTheme, Dialog, DialogTitle, DialogContent, DialogActions, Chip, Card, CardContent, Collapse
} from '@mui/material';
import { 
    Add as AddIcon,
    Send as SendIcon, 
    ArrowBack as ArrowBackIcon,
    EmojiEmotions as EmojiIcon,
    AttachFile as AttachFileIcon,
    People as PeopleIcon,
    Chat as ChatIcon,
    Close as CloseIcon,
    Announcement as AnnouncementIcon,
    Link as LinkIcon,
    Search as SearchIcon,
    ChevronRight as ChevronRightIcon,
    KeyboardArrowRight as ArrowRightIcon,
    KeyboardArrowLeft as ArrowLeftIcon,
    Apps as AppsIcon,
    CheckCircle as CheckCircleIcon,
    Settings as SettingsIcon,
    ContentCopy as ContentCopyIcon
} from '@mui/icons-material';
import { formatDistanceToNow, format } from 'date-fns';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { useLayout } from '../context/LayoutContext';
import { getAvatarColor } from '../utils/avatarUtils';
import axios from 'axios';
import EmojiPicker from 'emoji-picker-react';
import './ChatRoom.css';

/**
 * Parse bot message content - detects structured bot messages
 * Returns { isBotMessage: true, data: {...} } or { isBotMessage: false }
 */
const parseBotMessage = (content) => {
    if (!content || typeof content !== 'string') {
        return { isBotMessage: false };
    }

    // Check for new structured format
    if (content.startsWith('[BOT_MESSAGE]')) {
        try {
            const jsonStr = content.substring('[BOT_MESSAGE]'.length);
            const data = JSON.parse(jsonStr);
            return { isBotMessage: true, data };
        } catch (e) {
            return { isBotMessage: false };
        }
    }

    // Check for legacy format (🎮 Discord Update)
    if (content.includes('🎮 Discord Update from #')) {
        // Parse legacy format into structured data
        const channelMatch = content.match(/Discord Update from #(\S+)/);
        const messageCountMatch = content.match(/💬 (\d+) messages in (\S+)/);
        const timeMatch = content.match(/Activity Summary \(([^)]+)\)/);
        const summaryMatch = content.match(/in \S+\n\n([\s\S]*?)\n\n—Commonly Bot/);

        return {
            isBotMessage: true,
            isLegacy: true,
            data: {
                type: 'discord-summary',
                channel: channelMatch ? channelMatch[1] : 'general',
                server: messageCountMatch ? messageCountMatch[2] : 'Discord',
                messageCount: messageCountMatch ? parseInt(messageCountMatch[1], 10) : 0,
                timeRange: timeMatch ? { display: timeMatch[1] } : null,
                summary: summaryMatch ? summaryMatch[1].trim() : content,
            }
        };
    }

    return { isBotMessage: false };
};

const getIntegrationDisplay = (botData) => {
    const source = (botData.source || '').toLowerCase();
    const sourceLabel = botData.sourceLabel || botData.source || 'External';
    const emojiMap = {
        discord: '🎮',
        slack: '🟣',
        telegram: '📨',
        groupme: '💬',
        whatsapp: '🟢',
        messenger: '💠'
    };

    return {
        emoji: emojiMap[source] || '🔗',
        label: sourceLabel
    };
};

/**
 * Format time range for display in user's local timezone
 */
const formatTimeRange = (timeRange) => {
    if (!timeRange) return 'Recent activity';

    // Legacy format already has display string
    if (timeRange.display) return timeRange.display;

    // New format with ISO timestamps
    if (timeRange.start && timeRange.end) {
        try {
            const start = new Date(timeRange.start);
            const end = new Date(timeRange.end);
            return `${format(start, 'h:mm a')} - ${format(end, 'h:mm a')}`;
        } catch (e) {
            return 'Recent activity';
        }
    }

    return 'Recent activity';
};

const ChatRoom = () => {
    const { currentUser } = useAuth();
    const { socket, connected, pgAvailable, joinPod, leavePod, sendMessage } = useSocket();
    const { isDashboardCollapsed } = useLayout(); // Using global layout context
    const { podType, roomId } = useParams();
    const navigate = useNavigate();
    const theme = useTheme();
    const isMobile = useMediaQuery(theme.breakpoints.down('md'));
    const isTablet = useMediaQuery(theme.breakpoints.between('md', 'lg'));
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
    const sidebarRef = useRef(null);
    const messagesContainerRef = useRef(null);
    const skipNextAutoScrollRef = useRef(false);
    const [isLoadingOlder, setIsLoadingOlder] = useState(false);
    const [hasMoreMessages, setHasMoreMessages] = useState(true);
    const [usePostgresMessages, setUsePostgresMessages] = useState(false);
    const messagesPageSize = 50;
    const [podIntegrations, setPodIntegrations] = useState([]);
    const [integrationsLoading, setIntegrationsLoading] = useState(false);
    const [expandedIntegrations, setExpandedIntegrations] = useState({});
    const integrationRedirectBase = (process.env.REACT_APP_INTEGRATION_REDIRECT_BASE_URL
        || process.env.REACT_APP_API_URL
        || '').replace(/\/$/, '');
    
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
    const [groupmeSetupOpen, setGroupmeSetupOpen] = useState(false);
    const [groupmeIntegration, setGroupmeIntegration] = useState(null);
    const [groupmeDraftIntegrationId, setGroupmeDraftIntegrationId] = useState(null);
    const [groupmeBotId, setGroupmeBotId] = useState('');
    const [groupmeGroupId, setGroupmeGroupId] = useState('');
    const [groupmeError, setGroupmeError] = useState('');
    const [groupmeSaving, setGroupmeSaving] = useState(false);
    const [groupmeGroupName, setGroupmeGroupName] = useState('');
    const [groupmeGroupUrl, setGroupmeGroupUrl] = useState('');
    const groupmeDiscardOnCreateRef = useRef(false);
    
    // Fetch pod details and messages
    useEffect(() => {
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
                const messagesResponse = await axios.get(
                    `${messagesEndpoint}?limit=${messagesPageSize}`,
                    authHeaders
                );
                setUsePostgresMessages(usePostgres);
                setMessages(messagesResponse.data); // Backend returns messages in oldest-first order
                setHasMoreMessages((messagesResponse.data || []).length >= messagesPageSize);
                setError(null);

                // Fetch integrations for this pod
                try {
                    setIntegrationsLoading(true);
                    const integrationsRes = await axios.get(`/api/integrations/${roomId}`, authHeaders);
                    setPodIntegrations(integrationsRes.data || []);
                } catch (err) {
                    console.warn('Failed to fetch integrations for pod:', err.response?.status);
                } finally {
                    setIntegrationsLoading(false);
                }
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

    const fetchOlderMessages = async () => {
        if (!roomId || !hasMoreMessages || isLoadingOlder) {
            return;
        }

        const oldestMessage = messages[0];
        const oldestTimestamp = oldestMessage?.createdAt || oldestMessage?.created_at;
        if (!oldestTimestamp) {
            setHasMoreMessages(false);
            return;
        }

        const container = messagesContainerRef.current;
        const previousScrollHeight = container?.scrollHeight || 0;
        const previousScrollTop = container?.scrollTop || 0;

        setIsLoadingOlder(true);
        try {
            const token = localStorage.getItem('token');
            if (!token) {
                setError('Authentication required. Please log in again.');
                setIsLoadingOlder(false);
                return;
            }

            const authHeaders = {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            };

            const messagesEndpoint = usePostgresMessages
                ? `/api/pg/messages/${roomId}`
                : `/api/messages/${roomId}`;
            const beforeParam = encodeURIComponent(new Date(oldestTimestamp).toISOString());
            const olderResponse = await axios.get(
                `${messagesEndpoint}?limit=${messagesPageSize}&before=${beforeParam}`,
                authHeaders
            );
            const olderMessages = olderResponse.data || [];

            skipNextAutoScrollRef.current = true;
            setMessages((prevMessages) => {
                const existingKeys = new Set(
                    prevMessages.map((msg) => msg.id || msg._id || msg.created_at || msg.createdAt)
                );
                const filteredOlder = olderMessages.filter((msg) => {
                    const key = msg.id || msg._id || msg.created_at || msg.createdAt;
                    return !existingKeys.has(key);
                });
                return [...filteredOlder, ...prevMessages];
            });
            setHasMoreMessages(olderMessages.length >= messagesPageSize);
        } catch (err) {
            console.error('Error fetching older messages:', err);
            setHasMoreMessages(false);
        } finally {
            setIsLoadingOlder(false);
            if (messagesContainerRef.current) {
                requestAnimationFrame(() => {
                    const newScrollHeight = messagesContainerRef.current.scrollHeight;
                    messagesContainerRef.current.scrollTop = newScrollHeight - previousScrollHeight + previousScrollTop;
                });
            }
        }
    };

    const getDiscordOAuthUrl = (podId, guildId = null) => {
        const clientId = process.env.REACT_APP_DISCORD_CLIENT_ID;
        const redirectUri = encodeURIComponent(`${process.env.REACT_APP_API_URL}/api/discord/callback`);
        const scopes = encodeURIComponent('bot applications.commands');
        const permissions = '536873984';
        const state = `pod_${podId}`;
        const timestamp = Date.now();
        return `https://discord.com/api/oauth2/authorize?client_id=${clientId}&scope=${scopes}&permissions=${permissions}`
            + `&redirect_uri=${redirectUri}&response_type=code&state=${state}`
            + (guildId ? `&guild_id=${guildId}` : '')
            + `&t=${timestamp}`;
    };

    const getIntegrationRedirectUrl = (type) => {
        if (!roomId) return '#';
        if (type === 'discord') {
            return getDiscordOAuthUrl(roomId);
        }
        const externalSetupLinks = {
            slack: 'https://api.slack.com/apps',
            groupme: 'https://dev.groupme.com/bots/new',
            telegram: 'https://t.me/BotFather',
        };
        return externalSetupLinks[type] || '#';
    };

    const getGroupmeCallbackUrl = (integrationId) => {
        if (!integrationId) return '';
        const base = integrationRedirectBase || window.location.origin;
        return `${base}/api/webhooks/groupme/${integrationId}`;
    };

    const refreshPodIntegrations = async () => {
        if (!roomId) return;
        const token = localStorage.getItem('token');
        if (!token) return;
        try {
            const integrationsRes = await axios.get(`/api/integrations/${roomId}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            setPodIntegrations(integrationsRes.data || []);
        } catch (err) {
            console.warn('Failed to refresh integrations for pod:', err.response?.status);
        }
    };

    const cleanupGroupmeDraft = async (integrationId) => {
        if (!integrationId) return;
        const token = localStorage.getItem('token');
        if (!token) {
            setGroupmeDraftIntegrationId(null);
            setGroupmeIntegration(null);
            return;
        }

        try {
            await axios.delete(`/api/integrations/${integrationId}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
        } catch (err) {
            console.warn('Failed to discard GroupMe integration draft:', err.response?.status);
        } finally {
            setGroupmeDraftIntegrationId(null);
            setGroupmeIntegration(null);
            await refreshPodIntegrations();
        }
    };

    const handleGroupmeSetupOpen = async (existingIntegration = null) => {
        groupmeDiscardOnCreateRef.current = false;
        setGroupmeError('');
        setGroupmeBotId('');
        setGroupmeGroupId('');
        setGroupmeGroupName('');
        setGroupmeGroupUrl('');
        setGroupmeIntegration(null);
        setGroupmeDraftIntegrationId(null);
        setGroupmeSetupOpen(true);
        if (existingIntegration) {
            setGroupmeIntegration(existingIntegration);
            setGroupmeBotId(existingIntegration.config?.botId || '');
            setGroupmeGroupId(existingIntegration.config?.groupId || '');
            setGroupmeGroupName(existingIntegration.config?.groupName || '');
            setGroupmeGroupUrl(existingIntegration.config?.groupUrl || '');
            setGroupmeSaving(false);
            return;
        }

        setGroupmeSaving(true);

        try {
            const token = localStorage.getItem('token');
            const response = await axios.post('/api/integrations', {
                podId: roomId,
                type: 'groupme',
                config: { webhookListenerEnabled: true }
            }, {
                headers: { Authorization: `Bearer ${token}` }
            });

            const createdIntegration = response.data.integration || response.data;
            if (groupmeDiscardOnCreateRef.current) {
                await cleanupGroupmeDraft(createdIntegration?._id);
                return;
            }
            setGroupmeIntegration(createdIntegration);
            setGroupmeDraftIntegrationId(createdIntegration?._id || null);
        } catch (err) {
            console.error('Error creating GroupMe integration:', err);
            setGroupmeError('Failed to create GroupMe integration.');
        } finally {
            setGroupmeSaving(false);
        }
    };

    const handleGroupmeSetupClose = async () => {
        setGroupmeSetupOpen(false);
        setGroupmeError('');

        if (groupmeSaving && !groupmeIntegration) {
            groupmeDiscardOnCreateRef.current = true;
            return;
        }

        if (groupmeDraftIntegrationId) {
            await cleanupGroupmeDraft(groupmeDraftIntegrationId);
            return;
        }

        setGroupmeIntegration(null);
        setGroupmeDraftIntegrationId(null);
    };

    const handleGroupmeSave = async () => {
        if (!groupmeIntegration?._id) {
            setGroupmeError('Integration not ready yet.');
            return;
        }
        if (!groupmeBotId.trim() || !groupmeGroupId.trim()) {
            setGroupmeError('Please provide both Bot ID and Group ID.');
            return;
        }

        setGroupmeSaving(true);
        setGroupmeError('');

        try {
            const token = localStorage.getItem('token');
            await axios.patch(`/api/integrations/${groupmeIntegration._id}`, {
                config: {
                    botId: groupmeBotId.trim(),
                    groupId: groupmeGroupId.trim(),
                    groupName: groupmeGroupName.trim() || undefined,
                    groupUrl: groupmeGroupUrl.trim() || undefined
                },
                status: 'connected'
            }, {
                headers: { Authorization: `Bearer ${token}` }
            });

            setGroupmeSetupOpen(false);
            setGroupmeIntegration(null);
            setGroupmeDraftIntegrationId(null);
            groupmeDiscardOnCreateRef.current = false;
            await refreshPodIntegrations();
        } catch (err) {
            console.error('Error saving GroupMe integration:', err);
            setGroupmeError('Failed to save GroupMe integration.');
        } finally {
            setGroupmeSaving(false);
        }
    };

    const handleGroupmeCopy = async () => {
        try {
            const url = getGroupmeCallbackUrl(groupmeIntegration?._id);
            if (!url) return;
            await navigator.clipboard.writeText(url);
        } catch (err) {
            console.warn('Failed to copy GroupMe callback URL', err);
        }
    };

    const getIntegrationManageUrl = (type, integration) => {
        const config = integration?.config || {};
        switch (type) {
            case 'discord':
                if (config.channelUrl) {
                    return config.channelUrl;
                }
                if (config.serverId && config.channelId) {
                    return `https://discord.com/channels/${config.serverId}/${config.channelId}`;
                }
                return getDiscordOAuthUrl(roomId, config.serverId);
            case 'slack':
                return 'https://api.slack.com/apps';
            case 'telegram':
                return 'https://t.me/BotFather';
            case 'groupme':
                return 'https://dev.groupme.com/bots';
            default:
                return null;
        }
    };

    const handleManageIntegration = (type, integration) => {
        if (!integration) return;
        if (type === 'groupme') {
            handleGroupmeSetupOpen(integration);
            return;
        }
        const url = getIntegrationManageUrl(type, integration);
        if (url) {
            window.open(url, '_blank', 'noopener,noreferrer');
        }
    };

    const integrationOptions = [
        {
            id: 'discord',
            label: 'Discord',
            color: '#5865F2',
            hoverColor: '#4752C4',
            description: 'Connect Discord to sync messages with your server.',
            logo: 'https://cdn.simpleicons.org/discord/5865F2',
        },
        {
            id: 'slack',
            label: 'Slack',
            color: '#4A154B',
            hoverColor: '#3B1140',
            description: 'Install the Commonly app and choose channels.',
            logo: 'https://a.slack-edge.com/80588/marketing/img/icons/icon_slack_hash_colored.png',
        },
        {
            id: 'groupme',
            label: 'GroupMe',
            color: '#00A2FF',
            hoverColor: '#0089D9',
            description: 'Connect your GroupMe bot to start syncing.',
            logo: 'https://cdn.simpleicons.org/groupme/00A2FF',
        },
        {
            id: 'telegram',
            label: 'Telegram',
            color: '#229ED9',
            hoverColor: '#1B86BC',
            description: 'Authorize your bot and set a webhook.',
            logo: 'https://telegram.org/img/t_logo.png',
        }
    ];

    const getIntegrationOption = (type) => integrationOptions.find((option) => option.id === type);

    const getStatusColor = (status) => {
        switch (status) {
            case 'connected':
                return 'success';
            case 'pending':
                return 'warning';
            case 'error':
                return 'error';
            default:
                return 'default';
        }
    };

    const getStatusText = (status) => {
        switch (status) {
            case 'connected':
                return 'Connected';
            case 'pending':
                return 'Connecting...';
            case 'error':
                return 'Error';
            default:
                return 'Unknown';
        }
    };

    const getIntegrationDetails = (integration) => {
        const config = integration?.config || {};
        switch (integration?.type) {
            case 'discord': {
                const server = config.serverName || 'Discord Server';
                const channel = config.channelName ? `#${config.channelName}` : null;
                return channel ? `${server} · ${channel}` : server;
            }
            case 'slack': {
                if (config.channelName) return `#${config.channelName}`;
                if (config.channelId) return `Channel ${config.channelId}`;
                return 'Slack workspace';
            }
            case 'groupme':
                if (config.groupName) return config.groupName;
                return config.groupId ? `Group ${config.groupId}` : 'GroupMe bot connected';
            case 'telegram':
                return config.botUsername ? `@${config.botUsername}` : 'Telegram bot connected';
            default:
                return 'Integration connected';
        }
    };

    const visibleIntegrations = podIntegrations.filter((integration) => getIntegrationOption(integration.type));
    const integrationsByType = integrationOptions.reduce((acc, option) => {
        acc[option.id] = visibleIntegrations.filter((integration) => integration.type === option.id);
        return acc;
    }, {});

    const getAggregateStatus = (integrations = []) => {
        if (integrations.some((item) => item.status === 'error')) return 'error';
        if (integrations.some((item) => item.status === 'pending')) return 'pending';
        if (integrations.some((item) => item.status === 'connected')) return 'connected';
        return integrations[0]?.status || 'unknown';
    };

    const toggleIntegrationGroup = (type) => {
        setExpandedIntegrations((prev) => ({ ...prev, [type]: !prev[type] }));
    };

    const getStatusTone = (status) => {
        switch (status) {
            case 'connected':
                return 'success.main';
            case 'pending':
                return 'warning.main';
            case 'error':
                return 'error.main';
            default:
                return 'text.secondary';
        }
    };


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
        if (skipNextAutoScrollRef.current) {
            skipNextAutoScrollRef.current = false;
            return;
        }
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

    const handleMessageKeyDown = (event) => {
        if (event.key !== 'Enter') {
            return;
        }
        if (event.shiftKey) {
            event.stopPropagation();
            return;
        }
        event.preventDefault();
        handleSendMessage(event);
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

    // Close sidebar when clicking outside on mobile and tablet
    useEffect(() => {
        const handleSidebarClickOutside = (event) => {
            if ((isMobile || isTablet) && showMembers && sidebarRef.current &&
                !sidebarRef.current.contains(event.target) &&
                !event.target.closest('.members-button') &&
                !event.target.closest('.sidebar-toggle-button')) {
                setShowMembers(false);
            }
        };

        document.addEventListener('mousedown', handleSidebarClickOutside);
        return () => {
            document.removeEventListener('mousedown', handleSidebarClickOutside);
        };
    }, [isMobile, isTablet, showMembers]);

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
                ref={sidebarRef}
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
                
                {/* Apps section - View only, delete from profile page */}
                {room?.createdBy?._id === currentUser?._id && (
                    <div className="sidebar-section">
                        <div className="sidebar-section-title">
                            <span><AppsIcon style={{ marginRight: '8px', fontSize: '16px', color: '#5865F2' }} /> Apps</span>
                            <Typography variant="body2" color="text.secondary" sx={{ ml: 'auto', fontWeight: 500 }}>
                                Manage in Profile
                            </Typography>
                        </div>
                        <div className="sidebar-section-content">
                            <Box sx={{ mt: 2, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1.5 }}>
                                    <Box>
                                        <Typography variant="subtitle1" sx={{ fontWeight: 700, color: '#0F172A' }}>
                                            Integrations
                                        </Typography>
                                        <Typography variant="body2" color="text.secondary">
                                            Sync messages and summarize activity in this pod.
                                        </Typography>
                                    </Box>
                                    <Chip
                                        label={`${visibleIntegrations.length} connected`}
                                        size="small"
                                        variant="outlined"
                                        sx={{ fontWeight: 600, borderRadius: 2 }}
                                    />
                                </Box>

                                {integrationsLoading ? (
                                    <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
                                        <CircularProgress size={20} />
                                    </Box>
                                ) : (
                                    integrationOptions.map((item) => {
                                        const linked = integrationsByType[item.id] || [];
                                        const hasIntegration = linked.length > 0;
                                        const hasMultiple = linked.length > 1;
                                        const isExpanded = !!expandedIntegrations[item.id];
                                        const status = hasIntegration ? getAggregateStatus(linked) : null;
                                        const detailText = hasIntegration ? getIntegrationDetails(linked[0]) : item.description;
                                        const showCardManage = hasIntegration && !hasMultiple;

                                        return (
                                            <Card
                                                key={item.id}
                                                sx={{
                                                    position: 'relative',
                                                    overflow: 'hidden',
                                                    borderRadius: 2.5,
                                                    border: '1px solid',
                                                    borderColor: hasIntegration ? `${item.color}4D` : 'rgba(15, 23, 42, 0.08)',
                                                    backgroundColor: '#FFFFFF',
                                                    boxShadow: 'none',
                                                    '&::before': {
                                                        content: '""',
                                                        position: 'absolute',
                                                        left: 0,
                                                        top: 0,
                                                        bottom: 0,
                                                        width: 3,
                                                        backgroundColor: item.color,
                                                        opacity: hasIntegration ? 0.65 : 0.25
                                                    },
                                                    '&:hover': {
                                                        transform: 'translateY(-2px)',
                                                        boxShadow: '0 10px 22px rgba(15, 23, 42, 0.08)',
                                                        borderColor: `${item.color}66`
                                                    },
                                                    transition: 'all 0.3s ease'
                                                }}
                                            >
                                                <CardContent sx={{ p: 2, pl: 2.5, '&:last-child': { pb: 2 } }}>
                                                    {showCardManage && (
                                                        <Tooltip title="Manage integration">
                                                            <IconButton
                                                                size="small"
                                                                onClick={(event) => {
                                                                    event.preventDefault();
                                                                    handleManageIntegration(item.id, linked[0]);
                                                                }}
                                                                sx={{
                                                                    position: 'absolute',
                                                                    top: 10,
                                                                    right: 10,
                                                                    backgroundColor: 'rgba(255,255,255,0.9)',
                                                                    boxShadow: '0 2px 6px rgba(15, 23, 42, 0.08)',
                                                                    '&:hover': {
                                                                        backgroundColor: 'rgba(255,255,255,1)'
                                                                    }
                                                                }}
                                                            >
                                                                <SettingsIcon fontSize="small" />
                                                            </IconButton>
                                                        </Tooltip>
                                                    )}
                                                    <Box
                                                        sx={{
                                                            display: 'flex',
                                                            alignItems: 'center',
                                                            justifyContent: 'space-between',
                                                            gap: 2,
                                                            flexWrap: 'wrap'
                                                        }}
                                                    >
                                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flex: '1 1 auto' }}>
                                                            <Box
                                                                sx={{
                                                                    color: item.color,
                                                                    display: 'flex',
                                                                    alignItems: 'center',
                                                                    justifyContent: 'center',
                                                                    width: 32,
                                                                    height: 32,
                                                                    backgroundColor: `${item.color}1A`,
                                                                    borderRadius: 2
                                                                }}
                                                            >
                                                                <Box
                                                                    component="img"
                                                                    src={item.logo}
                                                                    alt={`${item.label} logo`}
                                                                    sx={{ width: 18, height: 18 }}
                                                                />
                                                            </Box>
                                                            <Box>
                                                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                                                                    <Typography variant="subtitle2" sx={{ fontWeight: 600, fontSize: '0.95rem' }}>
                                                                        {item.label}
                                                                    </Typography>
                                                                    {hasIntegration && (
                                                                        <Chip
                                                                            label={`${linked.length} connected`}
                                                                            size="small"
                                                                            variant="outlined"
                                                                            icon={hasMultiple ? (
                                                                                <ChevronRightIcon
                                                                                    sx={{
                                                                                        fontSize: 18,
                                                                                        transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                                                                                        transition: 'transform 0.2s ease'
                                                                                    }}
                                                                                />
                                                                            ) : undefined}
                                                                            onClick={hasMultiple ? () => toggleIntegrationGroup(item.id) : undefined}
                                                                            sx={{
                                                                                height: 20,
                                                                                fontWeight: 600,
                                                                                borderColor: `${item.color}66`,
                                                                                color: item.color,
                                                                                cursor: hasMultiple ? 'pointer' : 'default'
                                                                            }}
                                                                        />
                                                                    )}
                                                                </Box>
                                                                <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.4 }}>
                                                                    {detailText}
                                                                </Typography>
                                                            </Box>
                                                        </Box>
                                                    </Box>
                                                    <Box
                                                        sx={{
                                                            mt: 1.5,
                                                            display: 'flex',
                                                            alignItems: 'center',
                                                            justifyContent: 'space-between',
                                                            gap: 1,
                                                            flexWrap: 'nowrap'
                                                        }}
                                                    >
                                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'nowrap' }}>
                                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                                                                <Box
                                                                    sx={{
                                                                        width: 7,
                                                                        height: 7,
                                                                        borderRadius: '50%',
                                                                        backgroundColor: status ? getStatusTone(status) : 'text.secondary'
                                                                    }}
                                                                />
                                                                <Typography
                                                                    variant="caption"
                                                                    color="text.secondary"
                                                                    sx={{ fontWeight: 600, whiteSpace: 'nowrap' }}
                                                                >
                                                                    {status ? getStatusText(status) : 'Not connected'}
                                                                </Typography>
                                                            </Box>
                                                        </Box>
                                                        <Button
                                                            size="small"
                                                            variant={hasIntegration ? 'outlined' : 'contained'}
                                                            startIcon={<AddIcon fontSize="small" />}
                                                            href={item.id === 'groupme' ? undefined : getIntegrationRedirectUrl(item.id)}
                                                            target={item.id === 'groupme' ? undefined : '_blank'}
                                                            rel={item.id === 'groupme' ? undefined : 'noopener noreferrer'}
                                                            onClick={(event) => {
                                                                if (item.id === 'groupme') {
                                                                    event.preventDefault();
                                                                    handleGroupmeSetupOpen();
                                                                }
                                                            }}
                                                            sx={{
                                                                borderRadius: 2,
                                                                textTransform: 'none',
                                                                fontWeight: 600,
                                                                borderColor: hasIntegration ? `${item.color}66` : 'transparent',
                                                                color: hasIntegration ? item.color : '#FFFFFF',
                                                                backgroundColor: hasIntegration ? 'transparent' : item.color,
                                                                whiteSpace: 'nowrap',
                                                                '&:hover': {
                                                                    backgroundColor: hasIntegration ? `${item.color}0F` : item.hoverColor,
                                                                    borderColor: hasIntegration ? `${item.color}99` : 'transparent',
                                                                    transform: 'translateY(-1px)',
                                                                    boxShadow: hasIntegration ? 'none' : `0 4px 12px ${item.color}33`
                                                                },
                                                                transition: 'all 0.2s ease'
                                                            }}
                                                        >
                                                            {hasIntegration ? 'Add another' : `Add ${item.label}`}
                                                        </Button>
                                                    </Box>
                                                    {hasMultiple && (
                                                        <Collapse in={isExpanded} timeout="auto" unmountOnExit>
                                                            <Box sx={{ mt: 1.5, pt: 1.5, borderTop: '1px solid rgba(15, 23, 42, 0.08)' }}>
                                                                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                                                                    {linked.map((integration) => (
                                                                        <Box
                                                                            key={integration._id}
                                                                            sx={{
                                                                                display: 'flex',
                                                                                alignItems: 'center',
                                                                                justifyContent: 'space-between',
                                                                                gap: 1.5,
                                                                                p: 1,
                                                                                borderRadius: 2,
                                                                                backgroundColor: 'rgba(148, 163, 184, 0.12)'
                                                                            }}
                                                                        >
                                                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                                                                <Box
                                                                                    sx={{
                                                                                        width: 6,
                                                                                        height: 6,
                                                                                        borderRadius: '50%',
                                                                                        backgroundColor: getStatusTone(integration.status)
                                                                                    }}
                                                                                />
                                                                                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                                                                                    {getIntegrationDetails(integration)}
                                                                                </Typography>
                                                                            </Box>
                                                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                                                                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
                                                                                    {getStatusText(integration.status)}
                                                                                </Typography>
                                                                                <Tooltip title="Manage connection">
                                                                                    <IconButton
                                                                                        size="small"
                                                                                        onClick={(event) => {
                                                                                            event.preventDefault();
                                                                                            handleManageIntegration(item.id, integration);
                                                                                        }}
                                                                                        sx={{
                                                                                            ml: 0.5,
                                                                                            color: 'text.secondary'
                                                                                        }}
                                                                                    >
                                                                                        <SettingsIcon fontSize="inherit" />
                                                                                    </IconButton>
                                                                                </Tooltip>
                                                                            </Box>
                                                                        </Box>
                                                                    ))}
                                                                </Box>
                                                            </Box>
                                                        </Collapse>
                                                    )}
                                                </CardContent>
                                            </Card>
                                        );
                                    })
                                )}
                            </Box>
                            <Dialog
                                open={groupmeSetupOpen}
                                onClose={handleGroupmeSetupClose}
                                maxWidth="sm"
                                fullWidth
                            >
                                <DialogTitle>Connect GroupMe</DialogTitle>
                                <DialogContent sx={{ pt: 1 }}>
                                    <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                                        Create a GroupMe bot and paste this callback URL during setup.
                                    </Typography>
                                    <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mb: 2 }}>
                                        <TextField
                                            fullWidth
                                            size="small"
                                            value={groupmeIntegration ? getGroupmeCallbackUrl(groupmeIntegration._id) : 'Generating callback URL...'}
                                            InputProps={{ readOnly: true }}
                                        />
                                        <IconButton
                                            size="small"
                                            onClick={handleGroupmeCopy}
                                            disabled={!groupmeIntegration}
                                        >
                                            <ContentCopyIcon fontSize="small" />
                                        </IconButton>
                                        <Button
                                            variant="outlined"
                                            size="small"
                                            href="https://dev.groupme.com/bots/new"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            sx={{ whiteSpace: 'nowrap' }}
                                        >
                                            Open GroupMe
                                        </Button>
                                    </Box>
                                    <Typography variant="body2" sx={{ fontWeight: 600, mb: 1 }}>
                                        Enter bot details after creation
                                    </Typography>
                                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                                        <TextField
                                            label="Bot ID"
                                            size="small"
                                            value={groupmeBotId}
                                            onChange={(event) => setGroupmeBotId(event.target.value)}
                                        />
                                        <TextField
                                            label="Group ID"
                                            size="small"
                                            value={groupmeGroupId}
                                            onChange={(event) => setGroupmeGroupId(event.target.value)}
                                        />
                                        <TextField
                                            label="Group Name (optional)"
                                            size="small"
                                            value={groupmeGroupName}
                                            onChange={(event) => setGroupmeGroupName(event.target.value)}
                                        />
                                        <TextField
                                            label="Group Link URL (optional)"
                                            size="small"
                                            value={groupmeGroupUrl}
                                            onChange={(event) => setGroupmeGroupUrl(event.target.value)}
                                        />
                                    </Box>
                                    {groupmeError && (
                                        <Alert severity="error" sx={{ mt: 2 }}>
                                            {groupmeError}
                                        </Alert>
                                    )}
                                </DialogContent>
                                <DialogActions sx={{ px: 3, pb: 2 }}>
                                    <Button onClick={handleGroupmeSetupClose} disabled={groupmeSaving}>
                                        Cancel
                                    </Button>
                                    <Button
                                        variant="contained"
                                        onClick={handleGroupmeSave}
                                        disabled={groupmeSaving || !groupmeIntegration}
                                    >
                                        Save
                                    </Button>
                                </DialogActions>
                            </Dialog>
                        </div>
                    </div>
                )}
            </div>
            
            {/* Toggle button with improved positioning */}
            <button
                onClick={() => setShowMembers(!showMembers)}
                className={`sidebar-toggle-button ${showMembers ? 'visible' : ''}`}
            >
                {showMembers ? <ArrowRightIcon /> : <ArrowLeftIcon />}
            </button>
            
            {/* Main chat UI with updated class for sidebar visibility */}
            <Container maxWidth={false} disableGutters className={`chat-room-container ${isDashboardCollapsed ? 'dashboard-collapsed' : ''} ${showMembers ? 'sidebar-visible' : ''}`}>
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
                            ref={messagesContainerRef}
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
                                    {(hasMoreMessages || isLoadingOlder) && (
                                        <div className="load-older-wrapper">
                                            <Button
                                                variant="outlined"
                                                size="small"
                                                onClick={fetchOlderMessages}
                                                disabled={isLoadingOlder}
                                                className="load-older-button"
                                            >
                                                {isLoadingOlder ? (
                                                    <CircularProgress size={18} />
                                                ) : (
                                                    'Load older messages'
                                                )}
                                            </Button>
                                        </div>
                                    )}
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
                                            msg.profilePicture ||  // Handle camelCase from socket messages
                                            null;
                                        
                                        // Get message content with fallbacks
                                        const messageContent = msg.content || msg.text || '';

                                        // Get message type with fallback
                                        const messageType = msg.messageType || msg.message_type || 'text';

                                        // Get message timestamp with fallbacks
                                        const messageTime = msg.createdAt || msg.created_at || new Date();

                                        // Check if this is a bot message
                                        const isBot = username === 'commonly-bot';
                                        const botParsed = isBot ? parseBotMessage(messageContent) : { isBotMessage: false };

                                        // Render bot messages with formatted content inside regular bubble
                                        if (botParsed.isBotMessage && botParsed.data) {
                                            const botData = botParsed.data;
                                            const isDiscordSummary = botData.type === 'discord-summary';
                                            const display = getIntegrationDisplay(botData);
                                            const titleLabel = isDiscordSummary ? 'Discord' : display.label;
                                            const channelLabel = botData.channel ? `#${botData.channel}` : 'this channel';
                                            return (
                                                <ListItem
                                                    key={msg._id || msg.id || Date.now() + Math.random()}
                                                    className="message-item received"
                                                >
                                                    <ListItemAvatar className="message-avatar">
                                                        <Avatar sx={{ bgcolor: '#5865F2' }}>🤖</Avatar>
                                                    </ListItemAvatar>

                                                    <div className="message-content-wrapper">
                                                        <div className="message-user">
                                                            {username}
                                                            <span className="bot-badge">BOT</span>
                                                        </div>
                                                        <div className="message-bubble received bot-bubble">
                                                            <div className="bot-content">
                                                                <div className="bot-title">
                                                                    <span>{isDiscordSummary ? '🎮' : display.emoji}</span> {titleLabel} Update from{' '}
                                                                    {botData.channelUrl ? (
                                                                        <a
                                                                            href={botData.channelUrl}
                                                                            target="_blank"
                                                                            rel="noopener noreferrer"
                                                                            className="channel-link"
                                                                        >
                                                                            {channelLabel}
                                                                        </a>
                                                                    ) : (
                                                                        <strong>{channelLabel}</strong>
                                                                    )}
                                                                </div>
                                                                <div className="bot-meta">
                                                                    <span>💬 {botData.messageCount} messages</span>
                                                                    <span>🕐 {formatTimeRange(botData.timeRange)}</span>
                                                                </div>
                                                                <div className="bot-summary">{botData.summary}</div>
                                                            </div>
                                                        </div>
                                                        <div className="message-time message-received-time">
                                                            {formatDistanceToNow(new Date(messageTime), { addSuffix: true })}
                                                        </div>
                                                    </div>
                                                </ListItem>
                                            );
                                        }

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
                                                    <div className="message-user">{username}</div>
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
                                                                alt="Shared"
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
                    className={`message-input-container ${showMembers ? 'sidebar-visible' : 'sidebar-hidden'}`}
                >
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

                    <div className="composer-row">
                        <div className="composer-tools">
                            <Tooltip title="Emoji" placement="top">
                                <IconButton 
                                    onClick={toggleEmojiPicker} 
                                    className={`emoji-button ${showEmojiPicker ? 'active' : ''}`}
                                    aria-label="Insert emoji"
                                >
                                    <EmojiIcon />
                                </IconButton>
                            </Tooltip>
                            
                            <Tooltip title="Attach" placement="top">
                                <IconButton 
                                    component="label"
                                    className="attach-button"
                                    disabled={isUploading}
                                    aria-label="Attach image"
                                >
                                    <input
                                        type="file"
                                        accept="image/*"
                                        style={{ display: 'none' }}
                                        onChange={handleFileSelect}
                                        ref={fileInputRef}
                                    />
                                    {isUploading ? <CircularProgress size={20} /> : <AttachFileIcon />}
                                </IconButton>
                            </Tooltip>
                        </div>
                        
                        <TextField
                            fullWidth
                            placeholder={selectedFile ? 'Add a caption...' : `Message #${room?.name || 'chat'}`}
                            value={message}
                            onChange={(e) => setMessage(e.target.value)}
                            onKeyDown={handleMessageKeyDown}
                            variant="standard"
                            multiline
                            maxRows={5}
                            InputProps={{
                                disableUnderline: true,
                            }}
                            className="message-input"
                        />
                        
                        <Button 
                            color="primary"
                            type="submit"
                            variant="contained"
                            disableElevation
                            disabled={(!message.trim() && !selectedFile) || !connected || isUploading}
                            className="send-button"
                            endIcon={<SendIcon />}
                        >
                            Send
                        </Button>
                    </div>
                    
                    <div className="composer-hint">Shift+Enter for newline</div>
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
