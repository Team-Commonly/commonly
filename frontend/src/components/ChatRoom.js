/* eslint-disable max-len */
import React, { useState, useEffect, useRef, useMemo, useLayoutEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
    Container, Typography, Box, Paper, TextField, IconButton, Alert,
    Avatar, List, ListItem, ListItemAvatar,
    Button, CircularProgress, AppBar, Toolbar, MenuItem, Tooltip, useMediaQuery, useTheme, Dialog, DialogTitle, DialogContent, DialogActions, Chip, Card, CardContent, Collapse, FormControlLabel, Switch
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
    SmartToy as AgentIcon,
    CheckCircle as CheckCircleIcon,
    Settings as SettingsIcon,
    ContentCopy as ContentCopyIcon,
    PersonRemove as PersonRemoveIcon,
    Article as ArticleIcon
} from '@mui/icons-material';
import { formatDistanceToNow, format } from 'date-fns';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { useLayout } from '../context/LayoutContext';
import { getAvatarColor, getAvatarSrc } from '../utils/avatarUtils';
import { AgentAvatar, AgentBadge, isAgentUsername } from './common/AgentIndicator';
import { markPodReadFromMessages } from '../utils/podReadState';
import AgentEnsemblePanel from './agents/AgentEnsemblePanel';
import axios from 'axios';
import getApiBaseUrl, { normalizeUploadUrl } from '../utils/apiBaseUrl';
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
        messenger: '💠',
        x: '✖️',
        instagram: '📸'
    };

    return {
        emoji: emojiMap[source] || '🔗',
        label: sourceLabel
    };
};

const BASE_INTEGRATION_OPTIONS = [
    {
        id: 'discord',
        label: 'Discord',
        color: '#5865F2',
        hoverColor: '#4752C4',
        description: 'Connect Discord to sync messages with your server.',
        logo: 'https://cdn.simpleicons.org/discord/5865F2',
        capabilities: ['gateway', 'summary', 'commands'],
    },
    {
        id: 'slack',
        label: 'Slack',
        color: '#4A154B',
        hoverColor: '#3B1140',
        description: 'Install the Commonly app and choose channels.',
        logo: 'https://a.slack-edge.com/80588/marketing/img/icons/icon_slack_hash_colored.png',
        capabilities: ['webhook', 'summary', 'commands'],
    },
    {
        id: 'groupme',
        label: 'GroupMe',
        color: '#00A2FF',
        hoverColor: '#0089D9',
        description: 'Connect your GroupMe bot to start syncing.',
        logo: 'https://cdn.simpleicons.org/groupme/00A2FF',
        capabilities: ['webhook', 'commands', 'summary'],
    },
    {
        id: 'telegram',
        label: 'Telegram',
        color: '#229ED9',
        hoverColor: '#1B86BC',
        description: 'Add the bot to a chat and run /commonly-enable.',
        logo: 'https://telegram.org/img/t_logo.png',
        capabilities: ['webhook', 'summary', 'commands'],
    },
    {
        id: 'x',
        label: 'X',
        color: '#111827',
        hoverColor: '#0B0F1A',
        description: 'Pull posts from X into this pod.',
        logo: 'https://cdn.simpleicons.org/x/111827',
        capabilities: ['polling', 'posts', 'summary'],
    },
    {
        id: 'instagram',
        label: 'Instagram',
        color: '#E4405F',
        hoverColor: '#C13584',
        description: 'Pull Instagram posts into this pod.',
        logo: 'https://cdn.simpleicons.org/instagram/E4405F',
        capabilities: ['polling', 'posts', 'summary'],
    },
];

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

const normalizeIdentityKey = (value) => String(value || '').trim().toLowerCase();

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
    const [showMembers, setShowMembers] = useState(false); // Default to collapsed sidebar
    const messagesEndRef = useRef(null);
    const [selectedFile, setSelectedFile] = useState(null);
    const [previewUrl, setPreviewUrl] = useState('');
    const [isUploading, setIsUploading] = useState(false);
    const fileInputRef = useRef(null);
    const messageInputRef = useRef(null);
    const emojiPickerRef = useRef(null);
    const sidebarRef = useRef(null);
    const messagesContainerRef = useRef(null);
    const mentionDropdownRef = useRef(null);
    const skipNextAutoScrollRef = useRef(false);
    const initialScrollDoneRef = useRef(false);
    const [isLoadingOlder, setIsLoadingOlder] = useState(false);
    const [hasMoreMessages, setHasMoreMessages] = useState(true);
    const [usePostgresMessages, setUsePostgresMessages] = useState(false);
    const messagesPageSize = 50;
    const [podIntegrations, setPodIntegrations] = useState([]);
    const [integrationsLoading, setIntegrationsLoading] = useState(false);
    const [expandedIntegrations, setExpandedIntegrations] = useState({});
    const [podAgents, setPodAgents] = useState([]);
    const [podAgentsLoading, setPodAgentsLoading] = useState(false);
    const [podAgentsError, setPodAgentsError] = useState('');
    const [onlineMemberIds, setOnlineMemberIds] = useState([]);
    const [integrationCatalogEntries, setIntegrationCatalogEntries] = useState([]);
    const [memberActionError, setMemberActionError] = useState('');
    const [removingMemberIds, setRemovingMemberIds] = useState({});
    const integrationRedirectBase = (process.env.REACT_APP_INTEGRATION_REDIRECT_BASE_URL
        || getApiBaseUrl()
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

    const [mentionOpen, setMentionOpen] = useState(false);
    const [mentionQuery, setMentionQuery] = useState('');
    const [mentionStart, setMentionStart] = useState(-1);
    const [mentionIndex, setMentionIndex] = useState(0);
    const [qrCodeImage, setQrCodeImage] = useState(null);
    const qrCodeInputRef = useRef(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [groupmeSetupOpen, setGroupmeSetupOpen] = useState(false);
    const [groupmeIntegration, setGroupmeIntegration] = useState(null);
    const [groupmeDraftIntegrationId, setGroupmeDraftIntegrationId] = useState(null);
    const [groupmeBotId, setGroupmeBotId] = useState('');
    const [groupmeGroupId, setGroupmeGroupId] = useState('');
    const [groupmeAccessToken, setGroupmeAccessToken] = useState('');
    const [groupmeAgentAccessEnabled, setGroupmeAgentAccessEnabled] = useState(false);
    const [groupmeError, setGroupmeError] = useState('');
    const [groupmeSaving, setGroupmeSaving] = useState(false);
    const [groupmeGroupName, setGroupmeGroupName] = useState('');
    const [groupmeGroupUrl, setGroupmeGroupUrl] = useState('');
    const groupmeDiscardOnCreateRef = useRef(false);
    const [telegramSetupOpen, setTelegramSetupOpen] = useState(false);
    const [telegramIntegration, setTelegramIntegration] = useState(null);
    const [telegramDraftIntegrationId, setTelegramDraftIntegrationId] = useState(null);
    const [telegramConnectCode, setTelegramConnectCode] = useState('');
    const [telegramError, setTelegramError] = useState('');
    const [telegramSaving, setTelegramSaving] = useState(false);
    const telegramDiscardOnCreateRef = useRef(false);
    const [xSetupOpen, setXSetupOpen] = useState(false);
    const [xIntegration, setXIntegration] = useState(null);
    const [xDraftIntegrationId, setXDraftIntegrationId] = useState(null);
    const [xAccessToken, setXAccessToken] = useState('');
    const [xUsername, setXUsername] = useState('');
    const [xCategory, setXCategory] = useState('');
    const [xError, setXError] = useState('');
    const [xSaving, setXSaving] = useState(false);
    const xDiscardOnCreateRef = useRef(false);
    const [instagramSetupOpen, setInstagramSetupOpen] = useState(false);
    const [instagramIntegration, setInstagramIntegration] = useState(null);
    const [instagramDraftIntegrationId, setInstagramDraftIntegrationId] = useState(null);
    const [instagramAccessToken, setInstagramAccessToken] = useState('');
    const [instagramUserId, setInstagramUserId] = useState('');
    const [instagramUsername, setInstagramUsername] = useState('');
    const [instagramCategory, setInstagramCategory] = useState('');
    const [instagramError, setInstagramError] = useState('');
    const [instagramSaving, setInstagramSaving] = useState(false);
    const instagramDiscardOnCreateRef = useRef(false);

    const isPodAdmin = room?.createdBy?._id && currentUser?._id
        ? room.createdBy._id === currentUser._id
        : false;
    const canManageEnsemble = isPodAdmin || currentUser?.role === 'admin';

    const { agentDisplayMap, agentMentionMap, agentAvatarMap } = useMemo(() => {
        const displayMap = new Map();
        const mentionMap = new Map();
        const avatarMap = new Map();
        const register = (key, display, mention, avatar) => {
            const normalizedKey = normalizeIdentityKey(key);
            if (!normalizedKey) return;
            if (display) displayMap.set(normalizedKey, display);
            if (mention) mentionMap.set(normalizedKey, mention);
            if (avatar) avatarMap.set(normalizedKey, avatar);
        };
        (podAgents || []).forEach((agent) => {
            const username = buildAgentUsername(agent.name, agent.instanceId);
            const display = agent.profile?.displayName || agent.displayName || agent.name;
            const avatar = agent.profile?.iconUrl || agent.profile?.avatarUrl || agent.iconUrl || '';
            const instanceId = agent.instanceId || 'default';
            const displaySlug = display
                .toString()
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9-]/g, '-')
                .replace(/-+/g, '-')
                .replace(/^-+|-+$/g, '');
            const mentionValue = instanceId !== 'default'
                ? instanceId
                : (displaySlug || agent.name);
            register(username, display, mentionValue, avatar);
            register(agent.name, display, mentionValue, avatar);
            register(display, display, mentionValue, avatar);
            register(displaySlug, display, mentionValue, avatar);
            if (instanceId && instanceId !== 'default') {
                register(instanceId, display, mentionValue, avatar);
                register(`${agent.name}-${instanceId}`, display, mentionValue, avatar);
            }
        });
        return { agentDisplayMap: displayMap, agentMentionMap: mentionMap, agentAvatarMap: avatarMap };
    }, [podAgents]);

    const mentionableItems = useMemo(() => {
        const items = [];
        const seen = new Set();

        (room?.members || []).forEach((member) => {
            if (!member?.username) return;
            const key = member.username.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            const normalizedMemberKey = normalizeIdentityKey(member.username);
            const memberIsAgent = agentDisplayMap.has(normalizedMemberKey) || isAgentUsername(member.username);
            const agentLabel = memberIsAgent ? (agentDisplayMap.get(normalizedMemberKey) || member.username) : member.username;
            const mentionValue = memberIsAgent ? (agentMentionMap.get(normalizedMemberKey) || member.username) : member.username;
            const labelSearch = memberIsAgent
                ? `${agentLabel} ${mentionValue} ${member.username}`.toLowerCase()
                : key;
            items.push({
                id: member._id || key,
                label: agentLabel,
                labelLower: labelSearch,
                subtitle: memberIsAgent ? 'Agent' : (member._id === room?.createdBy?._id ? 'Admin' : 'Member'),
                avatar: member.profilePicture,
                isAgent: memberIsAgent,
                value: mentionValue,
            });
        });

        (podAgents || []).forEach((agent) => {
            const agentName = agent?.name;
            if (!agentName) return;
            const username = buildAgentUsername(agent.name, agent.instanceId);
            const key = username.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            const display = agent.profile?.displayName || agent.displayName || agent.name;
            const displaySlug = display
                .toString()
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9-]/g, '-')
                .replace(/-+/g, '-')
                .replace(/^-+|-+$/g, '');
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
                avatar: agent?.profile?.iconUrl || agent?.profile?.avatarUrl || agent?.iconUrl || '',
                isAgent: true,
                value: mentionValue,
            });
        });

        return items;
    }, [room?.members, room?.createdBy?._id, podAgents]);

    const filteredMentions = useMemo(() => {
        if (!mentionOpen) return [];
        const query = mentionQuery.trim().toLowerCase();
        const result = mentionableItems.filter((item) => item.labelLower.includes(query));
        return result.slice(0, 8);
    }, [mentionOpen, mentionQuery, mentionableItems]);

    const isCustomAvatarValue = useCallback((value) => Boolean(getAvatarSrc(value)), []);

    const pickPreferredAvatarValue = useCallback((...candidates) => {
        const normalized = candidates
            .map((value) => (typeof value === 'string' ? value.trim() : value))
            .filter(Boolean);
        const custom = normalized.find((value) => isCustomAvatarValue(value));
        return custom || normalized[0] || null;
    }, [isCustomAvatarValue]);

    const resolvePodAgentByIdentity = useCallback((identity) => {
        const normalizedIdentity = normalizeIdentityKey(identity);
        if (!normalizedIdentity) return null;
        return (podAgents || []).find((agent) => {
            const display = agent.profile?.displayName || agent.displayName || agent.name;
            const instanceId = agent.instanceId || 'default';
            const username = buildAgentUsername(agent.name, instanceId);
            const displaySlug = display
                .toString()
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9-]/g, '-')
                .replace(/-+/g, '-')
                .replace(/^-+|-+$/g, '');
            const keys = [
                username,
                agent.name,
                display,
                displaySlug,
                instanceId,
                `${agent.name}-${instanceId}`,
            ];
            return keys.some((key) => normalizeIdentityKey(key) === normalizedIdentity);
        }) || null;
    }, [podAgents]);

    const messageAvatarByUserId = useMemo(() => {
        const map = new Map();
        (messages || []).forEach((msg) => {
            const sender = msg?.userId;
            if (!sender || typeof sender !== 'object') return;
            const senderId = sender._id?.toString?.() || null;
            if (!senderId) return;
            const avatarCandidate = sender.profilePicture || msg.profile_picture || msg.profilePicture || null;
            if (!avatarCandidate) return;
            const existing = map.get(senderId) || null;
            map.set(senderId, pickPreferredAvatarValue(avatarCandidate, existing));
        });
        return map;
    }, [messages, pickPreferredAvatarValue]);

    const navigateToAgentInstallPage = useCallback((identity) => {
        const matchedAgent = resolvePodAgentByIdentity(identity);
        const params = new URLSearchParams();
        if (roomId) params.set('podId', roomId);
        params.set('tab', 'installed');
        params.set('view', 'overview');
        if (matchedAgent?.name) params.set('agent', matchedAgent.name);
        if (matchedAgent?.instanceId) params.set('instanceId', matchedAgent.instanceId);
        navigate(`/agents?${params.toString()}`);
    }, [navigate, resolvePodAgentByIdentity, roomId]);

    const navigateToUserProfile = useCallback((userId) => {
        if (userId) {
            navigate(`/profile/${userId}`);
            return;
        }
        navigate('/profile');
    }, [navigate]);
    
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

                // Fetch installed agents for this pod
                try {
                    setPodAgentsLoading(true);
                    const agentsRes = await axios.get(`/api/registry/pods/${roomId}/agents`, authHeaders);
                    setPodAgents(agentsRes.data?.agents || []);
                    setPodAgentsError('');
                } catch (err) {
                    console.warn('Failed to fetch agents for pod:', err.response?.status);
                    setPodAgentsError('Unable to load agents.');
                } finally {
                    setPodAgentsLoading(false);
                }

                // Fetch integration catalog metadata (best effort)
                try {
                    const catalogRes = await axios.get('/api/integrations/catalog', authHeaders);
                    setIntegrationCatalogEntries(catalogRes.data?.entries || []);
                } catch (err) {
                    console.warn('Failed to fetch integrations catalog:', err.response?.status);
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

    useEffect(() => {
        initialScrollDoneRef.current = false;
    }, [roomId]);

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
        const redirectUri = encodeURIComponent(`${getApiBaseUrl()}/api/discord/callback`);
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
            x: 'https://developer.x.com/en/portal/dashboard',
            instagram: 'https://developers.facebook.com/apps/',
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

    const refreshPodAgents = async () => {
        if (!roomId) return;
        const token = localStorage.getItem('token');
        if (!token) return;
        try {
            setPodAgentsLoading(true);
            const agentsRes = await axios.get(`/api/registry/pods/${roomId}/agents`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            setPodAgents(agentsRes.data?.agents || []);
            setPodAgentsError('');
        } catch (err) {
            console.warn('Failed to fetch agents for pod:', err.response?.status);
            setPodAgentsError('Unable to load agents.');
        } finally {
            setPodAgentsLoading(false);
        }
    };

    const handleRemovePodAgent = async (agentName) => {
        const token = localStorage.getItem('token');
        if (!token || !agentName || !roomId) return;
        try {
            await axios.delete(`/api/registry/agents/${agentName}/pods/${roomId}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            await refreshPodAgents();
        } catch (err) {
            console.error('Failed to remove agent from pod:', err);
            setPodAgentsError(err.response?.data?.error || 'Failed to remove agent.');
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
        setGroupmeAccessToken('');
        setGroupmeAgentAccessEnabled(false);
        setGroupmeGroupName('');
        setGroupmeGroupUrl('');
        setGroupmeIntegration(null);
        setGroupmeDraftIntegrationId(null);
        setGroupmeSetupOpen(true);
        if (existingIntegration) {
            setGroupmeIntegration(existingIntegration);
            setGroupmeBotId(existingIntegration.config?.botId || '');
            setGroupmeGroupId(existingIntegration.config?.groupId || '');
            setGroupmeAccessToken(existingIntegration.config?.accessToken || '');
            setGroupmeAgentAccessEnabled(Boolean(existingIntegration.config?.agentAccessEnabled));
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
        if (groupmeAgentAccessEnabled && !groupmeAccessToken.trim()) {
            setGroupmeError('Access Token is required when agent access is enabled.');
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
                    accessToken: groupmeAccessToken.trim() || undefined,
                    agentAccessEnabled: groupmeAgentAccessEnabled,
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

    const cleanupTelegramDraft = async (integrationId) => {
        if (!integrationId) return;
        const token = localStorage.getItem('token');
        if (!token) {
            setTelegramDraftIntegrationId(null);
            setTelegramIntegration(null);
            return;
        }

        try {
            await axios.delete(`/api/integrations/${integrationId}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
        } catch (err) {
            console.warn('Failed to discard Telegram integration draft:', err.response?.status);
        } finally {
            setTelegramDraftIntegrationId(null);
            setTelegramIntegration(null);
            await refreshPodIntegrations();
        }
    };

    const handleTelegramSetupOpen = async (existingIntegration = null) => {
        telegramDiscardOnCreateRef.current = false;
        setTelegramError('');
        setTelegramConnectCode('');
        setTelegramIntegration(null);
        setTelegramDraftIntegrationId(null);
        setTelegramSetupOpen(true);

        if (existingIntegration) {
            setTelegramIntegration(existingIntegration);
            setTelegramConnectCode(existingIntegration.config?.connectCode || '');
            setTelegramSaving(false);
            return;
        }

        setTelegramSaving(true);
        try {
            const token = localStorage.getItem('token');
            const response = await axios.post('/api/integrations', {
                podId: roomId,
                type: 'telegram',
                config: { webhookListenerEnabled: true }
            }, {
                headers: { Authorization: `Bearer ${token}` }
            });

            const createdIntegration = response.data.integration || response.data;
            if (telegramDiscardOnCreateRef.current) {
                await cleanupTelegramDraft(createdIntegration?._id);
                return;
            }
            setTelegramIntegration(createdIntegration);
            setTelegramDraftIntegrationId(createdIntegration?._id || null);
            setTelegramConnectCode(createdIntegration?.config?.connectCode || '');
        } catch (err) {
            console.error('Error creating Telegram integration:', err);
            setTelegramError('Failed to create Telegram integration.');
        } finally {
            setTelegramSaving(false);
        }
    };

    const handleTelegramSetupClose = async () => {
        setTelegramSetupOpen(false);
        setTelegramError('');

        if (telegramSaving && !telegramIntegration) {
            telegramDiscardOnCreateRef.current = true;
            return;
        }

        if (telegramDraftIntegrationId) {
            await cleanupTelegramDraft(telegramDraftIntegrationId);
            return;
        }

        setTelegramIntegration(null);
        setTelegramDraftIntegrationId(null);
    };

    const handleTelegramCopy = async () => {
        try {
            if (!telegramConnectCode) return;
            await navigator.clipboard.writeText(`/commonly-enable ${telegramConnectCode}`);
        } catch (err) {
            console.warn('Failed to copy Telegram command', err);
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

    const cleanupXDraft = async (integrationId) => {
        if (!integrationId) return;
        const token = localStorage.getItem('token');
        if (!token) {
            setXDraftIntegrationId(null);
            setXIntegration(null);
            return;
        }

        try {
            await axios.delete(`/api/integrations/${integrationId}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
        } catch (err) {
            console.warn('Failed to discard X integration draft:', err.response?.status);
        } finally {
            setXDraftIntegrationId(null);
            setXIntegration(null);
            await refreshPodIntegrations();
        }
    };

    const handleXSetupOpen = async (existingIntegration = null) => {
        xDiscardOnCreateRef.current = false;
        setXError('');
        setXAccessToken('');
        setXUsername('');
        setXCategory('');
        setXIntegration(null);
        setXDraftIntegrationId(null);
        setXSetupOpen(true);

        if (existingIntegration) {
            setXIntegration(existingIntegration);
            setXAccessToken(existingIntegration.config?.accessToken || '');
            setXUsername(existingIntegration.config?.username || '');
            setXCategory(existingIntegration.config?.category || '');
            setXSaving(false);
            return;
        }

        setXSaving(true);

        try {
            const token = localStorage.getItem('token');
            const response = await axios.post('/api/integrations', {
                podId: roomId,
                type: 'x',
                config: {}
            }, {
                headers: { Authorization: `Bearer ${token}` }
            });

            const createdIntegration = response.data.integration || response.data;
            if (xDiscardOnCreateRef.current) {
                await cleanupXDraft(createdIntegration?._id);
                return;
            }
            setXIntegration(createdIntegration);
            setXDraftIntegrationId(createdIntegration?._id || null);
        } catch (err) {
            console.error('Error creating X integration:', err);
            setXError('Failed to create X integration.');
        } finally {
            setXSaving(false);
        }
    };

    const handleXSetupClose = async () => {
        setXSetupOpen(false);
        setXError('');

        if (xSaving && !xIntegration) {
            xDiscardOnCreateRef.current = true;
            return;
        }

        if (xDraftIntegrationId) {
            await cleanupXDraft(xDraftIntegrationId);
            return;
        }

        setXIntegration(null);
        setXDraftIntegrationId(null);
    };

    const handleXSave = async () => {
        if (!xIntegration?._id) {
            setXError('Integration not ready yet.');
            return;
        }
        if (!xAccessToken.trim() || !xUsername.trim()) {
            setXError('Please provide both the access token and username.');
            return;
        }

        setXSaving(true);
        setXError('');

        try {
            const token = localStorage.getItem('token');
            await axios.patch(`/api/integrations/${xIntegration._id}`, {
                config: {
                    accessToken: xAccessToken.trim(),
                    username: xUsername.trim(),
                    category: xCategory.trim() || undefined
                },
                status: 'connected'
            }, {
                headers: { Authorization: `Bearer ${token}` }
            });

            setXSetupOpen(false);
            setXIntegration(null);
            setXDraftIntegrationId(null);
            xDiscardOnCreateRef.current = false;
            await refreshPodIntegrations();
        } catch (err) {
            console.error('Error saving X integration:', err);
            setXError('Failed to save X integration.');
        } finally {
            setXSaving(false);
        }
    };

    const cleanupInstagramDraft = async (integrationId) => {
        if (!integrationId) return;
        const token = localStorage.getItem('token');
        if (!token) {
            setInstagramDraftIntegrationId(null);
            setInstagramIntegration(null);
            return;
        }

        try {
            await axios.delete(`/api/integrations/${integrationId}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
        } catch (err) {
            console.warn('Failed to discard Instagram integration draft:', err.response?.status);
        } finally {
            setInstagramDraftIntegrationId(null);
            setInstagramIntegration(null);
            await refreshPodIntegrations();
        }
    };

    const handleInstagramSetupOpen = async (existingIntegration = null) => {
        instagramDiscardOnCreateRef.current = false;
        setInstagramError('');
        setInstagramAccessToken('');
        setInstagramUserId('');
        setInstagramUsername('');
        setInstagramCategory('');
        setInstagramIntegration(null);
        setInstagramDraftIntegrationId(null);
        setInstagramSetupOpen(true);

        if (existingIntegration) {
            setInstagramIntegration(existingIntegration);
            setInstagramAccessToken(existingIntegration.config?.accessToken || '');
            setInstagramUserId(existingIntegration.config?.igUserId || '');
            setInstagramUsername(existingIntegration.config?.username || '');
            setInstagramCategory(existingIntegration.config?.category || '');
            setInstagramSaving(false);
            return;
        }

        setInstagramSaving(true);

        try {
            const token = localStorage.getItem('token');
            const response = await axios.post('/api/integrations', {
                podId: roomId,
                type: 'instagram',
                config: {}
            }, {
                headers: { Authorization: `Bearer ${token}` }
            });

            const createdIntegration = response.data.integration || response.data;
            if (instagramDiscardOnCreateRef.current) {
                await cleanupInstagramDraft(createdIntegration?._id);
                return;
            }
            setInstagramIntegration(createdIntegration);
            setInstagramDraftIntegrationId(createdIntegration?._id || null);
        } catch (err) {
            console.error('Error creating Instagram integration:', err);
            setInstagramError('Failed to create Instagram integration.');
        } finally {
            setInstagramSaving(false);
        }
    };

    const handleInstagramSetupClose = async () => {
        setInstagramSetupOpen(false);
        setInstagramError('');

        if (instagramSaving && !instagramIntegration) {
            instagramDiscardOnCreateRef.current = true;
            return;
        }

        if (instagramDraftIntegrationId) {
            await cleanupInstagramDraft(instagramDraftIntegrationId);
            return;
        }

        setInstagramIntegration(null);
        setInstagramDraftIntegrationId(null);
    };

    const handleInstagramSave = async () => {
        if (!instagramIntegration?._id) {
            setInstagramError('Integration not ready yet.');
            return;
        }
        if (!instagramAccessToken.trim() || !instagramUserId.trim()) {
            setInstagramError('Please provide both the access token and IG user ID.');
            return;
        }

        setInstagramSaving(true);
        setInstagramError('');

        try {
            const token = localStorage.getItem('token');
            await axios.patch(`/api/integrations/${instagramIntegration._id}`, {
                config: {
                    accessToken: instagramAccessToken.trim(),
                    igUserId: instagramUserId.trim(),
                    username: instagramUsername.trim() || undefined,
                    category: instagramCategory.trim() || undefined
                },
                status: 'connected'
            }, {
                headers: { Authorization: `Bearer ${token}` }
            });

            setInstagramSetupOpen(false);
            setInstagramIntegration(null);
            setInstagramDraftIntegrationId(null);
            instagramDiscardOnCreateRef.current = false;
            await refreshPodIntegrations();
        } catch (err) {
            console.error('Error saving Instagram integration:', err);
            setInstagramError('Failed to save Instagram integration.');
        } finally {
            setInstagramSaving(false);
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
            case 'groupme':
                return 'https://dev.groupme.com/bots';
            case 'x':
                return 'https://developer.x.com/en/portal/dashboard';
            case 'instagram':
                return 'https://developers.facebook.com/apps/';
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
        if (type === 'telegram') {
            handleTelegramSetupOpen(integration);
            return;
        }
        if (type === 'x') {
            handleXSetupOpen(integration);
            return;
        }
        if (type === 'instagram') {
            handleInstagramSetupOpen(integration);
            return;
        }
        const url = getIntegrationManageUrl(type, integration);
        if (url) {
            window.open(url, '_blank', 'noopener,noreferrer');
        }
    };

    const integrationCatalogById = useMemo(() => integrationCatalogEntries.reduce((acc, entry) => ({
        ...acc,
        [entry.id]: entry,
    }), {}), [integrationCatalogEntries]);

    const integrationOptions = useMemo(() => BASE_INTEGRATION_OPTIONS.map((option) => {
        const catalogEntry = integrationCatalogById[option.id];
        if (!catalogEntry?.catalog) {
            return option;
        }
        return {
            ...option,
            label: catalogEntry.catalog.label || option.label,
            description: catalogEntry.catalog.description || option.description,
            capabilities: catalogEntry.catalog.capabilities || option.capabilities || [],
        };
    }), [integrationCatalogById]);

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

    const integrationSupportsAgentAccess = (type) => ['discord', 'groupme'].includes(type);

    const hasAgentAccessEnabled = (integration) => (
        integrationSupportsAgentAccess(integration?.type)
        && Boolean(integration?.config?.agentAccessEnabled)
    );

    const getAggregateAgentAccess = (integrations = []) => {
        const supported = integrations.filter((integration) => integrationSupportsAgentAccess(integration?.type));
        if (!supported.length) return null;
        return supported.some((integration) => hasAgentAccessEnabled(integration));
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
                if (config.chatTitle) return config.chatTitle;
                return config.chatId ? `Chat ${config.chatId}` : 'Telegram bot connected';
            case 'x':
                if (config.username) return `@${config.username}`;
                return config.userId ? `User ${config.userId}` : 'X feed connected';
            case 'instagram':
                if (config.username) return `@${config.username}`;
                return config.igUserId ? `IG ${config.igUserId}` : 'Instagram feed connected';
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

    // Track online members for the current pod
    useEffect(() => {
        if (!connected || !roomId || !socket) return undefined;

        const handlePresence = (payload) => {
            if (!payload || payload.podId !== roomId) return;
            setOnlineMemberIds(payload.userIds || []);
        };

        socket.on('podPresence', handlePresence);

        return () => {
            socket.off('podPresence', handlePresence);
        };
    }, [connected, roomId, socket]);
    
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
    const scrollToBottom = (behavior = 'auto') => {
        const container = messagesContainerRef.current;
        if (container) {
            container.scrollTop = container.scrollHeight;
            return;
        }
        messagesEndRef.current?.scrollIntoView({ behavior });
    };

    useLayoutEffect(() => {
        if (!loading && messages.length > 0 && !initialScrollDoneRef.current) {
            initialScrollDoneRef.current = true;
            requestAnimationFrame(() => {
                scrollToBottom('auto');
            });
        }
    }, [loading, messages.length]);

    useEffect(() => {
        if (skipNextAutoScrollRef.current) {
            skipNextAutoScrollRef.current = false;
            return;
        }
        if (!initialScrollDoneRef.current) return;
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    useEffect(() => {
        if (!currentUser?._id || !roomId || !messages.length) return;
        markPodReadFromMessages({
            userId: currentUser._id,
            podId: roomId,
            messages,
        });
    }, [currentUser?._id, roomId, messages]);
    
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
        handleSendMessage(event);
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
        const input = messageInputRef.current;
        if (!input) return;
        const cursor = input.selectionStart ?? message.length;
        const start = mentionStart >= 0 ? mentionStart : message.lastIndexOf('@', cursor);
        if (start < 0) return;
        const insert = `@${item.value || item.label}`;
        const nextValue = `${message.slice(0, start)}${insert} ${message.slice(cursor)}`;
        setMessage(nextValue);
        setMentionOpen(false);
        setMentionQuery('');
        setMentionStart(-1);
        requestAnimationFrame(() => {
            const nextCursor = start + insert.length + 1;
            input.focus();
            input.setSelectionRange(nextCursor, nextCursor);
        });
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

    useEffect(() => {
        const handleMentionClickOutside = (event) => {
            if (!mentionOpen) return;
            if (mentionDropdownRef.current && mentionDropdownRef.current.contains(event.target)) return;
            if (messageInputRef.current && messageInputRef.current.contains(event.target)) return;
            setMentionOpen(false);
        };

        document.addEventListener('mousedown', handleMentionClickOutside);
        return () => {
            document.removeEventListener('mousedown', handleMentionClickOutside);
        };
    }, [mentionOpen]);

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

    useEffect(() => {
        if ((isMobile || isTablet) && showMembers) {
            setShowMembers(false);
        }
    }, [isMobile, isTablet]);

    useEffect(() => {
        if (isMobile && !isDashboardCollapsed && showMembers) {
            setShowMembers(false);
        }
    }, [isMobile, isDashboardCollapsed, showMembers]);

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

    useEffect(() => {
        if (!mentionOpen) return;
        if (mentionIndex >= filteredMentions.length) {
            setMentionIndex(0);
        }
    }, [mentionOpen, mentionIndex, filteredMentions.length]);
    
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

    const handleRemoveMember = async (memberId, memberName) => {
        if (!roomId || !memberId) return;
        const confirmed = window.confirm(`Remove ${memberName || 'this member'} from the pod?`);
        if (!confirmed) return;

        setRemovingMemberIds(prev => ({ ...prev, [memberId]: true }));
        setMemberActionError('');
        try {
            const token = localStorage.getItem('token');
            if (!token) {
                setMemberActionError('Authentication required. Please log in again.');
                return;
            }

            const response = await axios.delete(`/api/pods/${roomId}/members/${memberId}`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            setRoom(response.data);
            setOnlineMemberIds(prev => prev.filter(id => id !== memberId));
        } catch (error) {
            console.error('Failed to remove member:', error);
            setMemberActionError(error.response?.data?.msg || 'Failed to remove member. Please try again.');
        } finally {
            setRemovingMemberIds(prev => {
                const next = { ...prev };
                delete next[memberId];
                return next;
            });
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
                        {memberActionError && (
                            <Alert severity="error" sx={{ mb: 1 }}>
                                {memberActionError}
                            </Alert>
                        )}
                        {room?.members?.map(member => {
                            const normalizedMemberKey = normalizeIdentityKey(member.username);
                            const matchedAgent = resolvePodAgentByIdentity(member.username);
                            const memberIsAgent = Boolean(matchedAgent) || agentDisplayMap.has(normalizedMemberKey) || isAgentUsername(member.username);
                            const isOnline = onlineMemberIds.includes(member._id)
                                || member._id === currentUser?._id;
                            const isCreator = member._id === room?.createdBy?._id;
                            const canRemove = isPodAdmin && !memberIsAgent && !isCreator && member._id !== currentUser?._id;
                            const agentDisplayName = memberIsAgent ? (agentDisplayMap.get(normalizedMemberKey) || member.username) : member.username;
                            const memberId = member._id?.toString?.() || null;
                            const resolvedHumanAvatar = pickPreferredAvatarValue(
                                memberId && currentUser?._id?.toString?.() === memberId ? currentUser?.profilePicture : null,
                                memberId ? messageAvatarByUserId.get(memberId) : null,
                                member.profilePicture,
                            );
                            const resolvedAgentAvatar = pickPreferredAvatarValue(
                                agentAvatarMap.get(normalizedMemberKey),
                                matchedAgent?.profile?.iconUrl,
                                matchedAgent?.profile?.avatarUrl,
                                matchedAgent?.iconUrl,
                                member.profilePicture,
                            );
                            const openMemberDestination = () => {
                                if (memberIsAgent) {
                                    navigateToAgentInstallPage(member.username);
                                    return;
                                }
                                navigateToUserProfile(member._id);
                            };
                            return (
                                <div key={member._id} className="sidebar-member">
                                    <div className="sidebar-member-link" onClick={openMemberDestination}>
                                        {memberIsAgent ? (
                                            <AgentAvatar
                                                username={member.username}
                                                src={getAvatarSrc(resolvedAgentAvatar)}
                                                size={32}
                                                showBadge={true}
                                            />
                                        ) : (
                                            <Avatar
                                                className="sidebar-member-avatar"
                                                src={getAvatarSrc(resolvedHumanAvatar)}
                                                sx={{ bgcolor: getAvatarColor(resolvedHumanAvatar || 'default'), width: 32, height: 32 }}
                                            >
                                                {member.username?.charAt(0).toUpperCase()}
                                            </Avatar>
                                        )}
                                        <div className="sidebar-member-info">
                                            <div className="sidebar-member-name">
                                                {agentDisplayName}
                                                {memberIsAgent && <AgentBadge username={member.username} size="small" showLabel={false} />}
                                            </div>
                                            <div className="sidebar-member-role">
                                                {memberIsAgent ? 'Agent' : (member._id === room?.createdBy?._id ? 'Admin' : 'Member')}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="sidebar-member-actions">
                                        <div className={`sidebar-member-status ${isOnline ? '' : 'offline'}`}></div>
                                        {canRemove && (
                                            <Tooltip title="Remove member" arrow>
                                                <span>
                                                    <IconButton
                                                        className="sidebar-member-remove"
                                                        size="small"
                                                        aria-label="Remove member"
                                                        disabled={Boolean(removingMemberIds[member._id])}
                                                        onClick={() => handleRemoveMember(member._id, member.username)}
                                                    >
                                                        <PersonRemoveIcon fontSize="small" />
                                                    </IconButton>
                                                </span>
                                            </Tooltip>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
                
                {/* Agents section */}
                <div className="sidebar-section">
                    <div className="sidebar-section-title">
                        <span><AgentIcon style={{ marginRight: '8px', fontSize: '16px', color: '#6366f1' }} /> Agents</span>
                        <Button
                            size="small"
                            variant="text"
                            onClick={() => navigate(`/agents?podId=${roomId}`)}
                            sx={{ ml: 'auto', fontWeight: 600 }}
                        >
                            Manage
                        </Button>
                    </div>
                    <div className="sidebar-section-content">
                        {podAgentsError && (
                            <Alert severity="warning" sx={{ mb: 1 }}>
                                {podAgentsError}
                            </Alert>
                        )}
                        {podAgentsLoading ? (
                            <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
                                <CircularProgress size={20} />
                            </Box>
                        ) : podAgents.length === 0 ? (
                            <Typography variant="body2" color="text.secondary">
                                No agents installed yet.
                            </Typography>
                        ) : (
                            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                                {podAgents.map((agent) => {
                                    const canRemoveAgent = currentUser?.role === 'admin'
                                        || room?.createdBy?._id === currentUser?._id
                                        || (agent.installedBy && agent.installedBy === currentUser?._id);
                                    const openAgentDestination = () => navigateToAgentInstallPage(
                                        buildAgentUsername(agent.name, agent.instanceId || 'default'),
                                    );
                                    return (
                                        <Box
                                            key={agent.name}
                                            sx={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'space-between',
                                                gap: 1,
                                                p: 1,
                                                borderRadius: 1.5,
                                                border: '1px solid rgba(148, 163, 184, 0.2)',
                                                backgroundColor: 'rgba(30, 41, 59, 0.7)'
                                            }}
                                        >
                                            <Box sx={{ minWidth: 0, cursor: 'pointer' }} onClick={openAgentDestination}>
                                                <Typography variant="subtitle2" sx={{ fontWeight: 700, color: '#e2e8f0' }}>
                                                    {agent.profile?.displayName || agent.name}
                                                </Typography>
                                                <Typography variant="caption" color="text.secondary">
                                                    {agent.version ? `v${agent.version}` : 'Version unknown'}
                                                </Typography>
                                            </Box>
                                            {canRemoveAgent && (
                                                <Button
                                                    size="small"
                                                    color="error"
                                                    onClick={() => handleRemovePodAgent(agent.name)}
                                                >
                                                    Remove
                                                </Button>
                                            )}
                                        </Box>
                                    );
                                })}
                            </Box>
                        )}
                    </div>
                </div>

                {room?.type === 'agent-ensemble' && (
                    <AgentEnsemblePanel
                        podId={roomId}
                        podAgents={podAgents}
                        isPodAdmin={canManageEnsemble}
                    />
                )}

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
                                        const aggregateAgentAccess = hasIntegration ? getAggregateAgentAccess(linked) : null;
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
                                                            {aggregateAgentAccess !== null && (
                                                                <Chip
                                                                    size="small"
                                                                    label={aggregateAgentAccess ? 'Agent access on' : 'Agent access off'}
                                                                    variant={aggregateAgentAccess ? 'filled' : 'outlined'}
                                                                    color={aggregateAgentAccess ? 'success' : 'default'}
                                                                    sx={{ height: 20, fontWeight: 600 }}
                                                                />
                                                            )}
                                                        </Box>
                                                        <Button
                                                            size="small"
                                                            variant={hasIntegration ? 'outlined' : 'contained'}
                                                            startIcon={<AddIcon fontSize="small" />}
                                                            href={['groupme', 'telegram', 'x', 'instagram'].includes(item.id) ? undefined : getIntegrationRedirectUrl(item.id)}
                                                            target={['groupme', 'telegram', 'x', 'instagram'].includes(item.id) ? undefined : '_blank'}
                                                            rel={['groupme', 'telegram', 'x', 'instagram'].includes(item.id) ? undefined : 'noopener noreferrer'}
                                                            onClick={(event) => {
                                                                if (item.id === 'groupme') {
                                                                    event.preventDefault();
                                                                    handleGroupmeSetupOpen();
                                                                } else if (item.id === 'telegram') {
                                                                    event.preventDefault();
                                                                    handleTelegramSetupOpen();
                                                                } else if (item.id === 'x') {
                                                                    event.preventDefault();
                                                                    handleXSetupOpen();
                                                                } else if (item.id === 'instagram') {
                                                                    event.preventDefault();
                                                                    handleInstagramSetupOpen();
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
                                                                                {integrationSupportsAgentAccess(integration.type) && (
                                                                                    <Chip
                                                                                        size="small"
                                                                                        label={hasAgentAccessEnabled(integration) ? 'Agent access on' : 'Agent access off'}
                                                                                        variant={hasAgentAccessEnabled(integration) ? 'filled' : 'outlined'}
                                                                                        color={hasAgentAccessEnabled(integration) ? 'success' : 'default'}
                                                                                        sx={{ height: 18, fontWeight: 600 }}
                                                                                    />
                                                                                )}
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
                                            label="Access Token (for agent message fetch)"
                                            size="small"
                                            type="password"
                                            value={groupmeAccessToken}
                                            onChange={(event) => setGroupmeAccessToken(event.target.value)}
                                            helperText="Required only when enabling agent access."
                                        />
                                        <FormControlLabel
                                            control={(
                                                <Switch
                                                    checked={groupmeAgentAccessEnabled}
                                                    onChange={(event) => setGroupmeAgentAccessEnabled(event.target.checked)}
                                                />
                                            )}
                                            label="Allow agents to fetch GroupMe messages"
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
                            <Dialog
                                open={telegramSetupOpen}
                                onClose={handleTelegramSetupClose}
                                maxWidth="sm"
                                fullWidth
                            >
                                <DialogTitle>Connect Telegram</DialogTitle>
                                <DialogContent sx={{ pt: 1 }}>
                                    <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                                        Add the Commonly bot to your Telegram group or channel, then run the command below in that chat to link it to this pod.
                                    </Typography>
                                    <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mb: 2 }}>
                                        <TextField
                                            fullWidth
                                            size="small"
                                            value={telegramConnectCode
                                                ? `/commonly-enable ${telegramConnectCode}`
                                                : (telegramIntegration?.config?.chatId ? 'Chat already connected' : 'Generating command...')}
                                            InputProps={{ readOnly: true }}
                                        />
                                        <IconButton
                                            size="small"
                                            onClick={handleTelegramCopy}
                                            disabled={!telegramConnectCode}
                                        >
                                            <ContentCopyIcon fontSize="small" />
                                        </IconButton>
                                        <Button
                                            variant="outlined"
                                            size="small"
                                            href="https://t.me/BotFather"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            sx={{ whiteSpace: 'nowrap' }}
                                        >
                                            Open BotFather
                                        </Button>
                                    </Box>
                                    {telegramIntegration?.config?.chatId && (
                                        <Alert severity="success" sx={{ mb: 2 }}>
                                            Connected to {telegramIntegration.config.chatTitle || `chat ${telegramIntegration.config.chatId}`}.
                                        </Alert>
                                    )}
                                    <Typography variant="caption" color="text.secondary">
                                        Tip: Disable privacy mode in BotFather if you want the bot to read all messages (not just commands).
                                    </Typography>
                                    {telegramError && (
                                        <Alert severity="error" sx={{ mt: 2 }}>
                                            {telegramError}
                                        </Alert>
                                    )}
                                </DialogContent>
                                <DialogActions sx={{ px: 3, pb: 2 }}>
                                    <Button onClick={handleTelegramSetupClose} disabled={telegramSaving}>
                                        Close
                                    </Button>
                                </DialogActions>
                            </Dialog>
                            <Dialog
                                open={xSetupOpen}
                                onClose={handleXSetupClose}
                                maxWidth="sm"
                                fullWidth
                            >
                                <DialogTitle>Connect X</DialogTitle>
                                <DialogContent sx={{ pt: 1 }}>
                                    <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                                        Add an X API bearer token and the account username you want to sync into this pod.
                                    </Typography>
                                    <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mb: 2 }}>
                                        <Button
                                            variant="outlined"
                                            size="small"
                                            href="https://developer.x.com/en/portal/dashboard"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            sx={{ whiteSpace: 'nowrap' }}
                                        >
                                            Open X Developer Portal
                                        </Button>
                                    </Box>
                                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                                        <TextField
                                            label="Access Token"
                                            size="small"
                                            type="password"
                                            value={xAccessToken}
                                            onChange={(event) => setXAccessToken(event.target.value)}
                                        />
                                        <TextField
                                            label="Username"
                                            size="small"
                                            value={xUsername}
                                            onChange={(event) => setXUsername(event.target.value)}
                                        />
                                        <TextField
                                            label="Post Category (optional)"
                                            size="small"
                                            value={xCategory}
                                            onChange={(event) => setXCategory(event.target.value)}
                                        />
                                    </Box>
                                    {xError && (
                                        <Alert severity="error" sx={{ mt: 2 }}>
                                            {xError}
                                        </Alert>
                                    )}
                                </DialogContent>
                                <DialogActions sx={{ px: 3, pb: 2 }}>
                                    <Button onClick={handleXSetupClose} disabled={xSaving}>
                                        Cancel
                                    </Button>
                                    <Button
                                        variant="contained"
                                        onClick={handleXSave}
                                        disabled={xSaving || !xIntegration}
                                    >
                                        Save
                                    </Button>
                                </DialogActions>
                            </Dialog>
                            <Dialog
                                open={instagramSetupOpen}
                                onClose={handleInstagramSetupClose}
                                maxWidth="sm"
                                fullWidth
                            >
                                <DialogTitle>Connect Instagram</DialogTitle>
                                <DialogContent sx={{ pt: 1 }}>
                                    <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                                        Provide an Instagram Graph API access token and the IG user ID to sync.
                                    </Typography>
                                    <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mb: 2 }}>
                                        <Button
                                            variant="outlined"
                                            size="small"
                                            href="https://developers.facebook.com/apps/"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            sx={{ whiteSpace: 'nowrap' }}
                                        >
                                            Open Meta App Dashboard
                                        </Button>
                                    </Box>
                                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                                        <TextField
                                            label="Access Token"
                                            size="small"
                                            type="password"
                                            value={instagramAccessToken}
                                            onChange={(event) => setInstagramAccessToken(event.target.value)}
                                        />
                                        <TextField
                                            label="IG User ID"
                                            size="small"
                                            value={instagramUserId}
                                            onChange={(event) => setInstagramUserId(event.target.value)}
                                        />
                                        <TextField
                                            label="Username (optional)"
                                            size="small"
                                            value={instagramUsername}
                                            onChange={(event) => setInstagramUsername(event.target.value)}
                                        />
                                        <TextField
                                            label="Post Category (optional)"
                                            size="small"
                                            value={instagramCategory}
                                            onChange={(event) => setInstagramCategory(event.target.value)}
                                        />
                                    </Box>
                                    {instagramError && (
                                        <Alert severity="error" sx={{ mt: 2 }}>
                                            {instagramError}
                                        </Alert>
                                    )}
                                </DialogContent>
                                <DialogActions sx={{ px: 3, pb: 2 }}>
                                    <Button onClick={handleInstagramSetupClose} disabled={instagramSaving}>
                                        Cancel
                                    </Button>
                                    <Button
                                        variant="contained"
                                        onClick={handleInstagramSave}
                                        disabled={instagramSaving || !instagramIntegration}
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
                    {!isMobile && (
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
                                <Button
                                    size="small"
                                    variant="outlined"
                                    startIcon={<ArticleIcon />}
                                    onClick={() => navigate(`/feed?podId=${roomId}`)}
                                    sx={{ textTransform: 'none' }}
                                >
                                    Posts
                                </Button>
                            </Toolbar>
                        </AppBar>
                    )}
                    
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
                                        const normalizedUsername = normalizeIdentityKey(username);
                                        const mappedDisplayName = agentDisplayMap.get(normalizedUsername);
                                        const matchedAgent = resolvePodAgentByIdentity(username);
                                        const isAgentMessage = Boolean(matchedAgent) || Boolean(mappedDisplayName) || isAgentUsername(username);
                                        const displayName = mappedDisplayName || username;
                                        const messageSenderId = (msg.userId && typeof msg.userId === 'object' && msg.userId._id)
                                            || msg.user_id
                                            || (typeof msg.userId === 'string' ? msg.userId : null)
                                            || null;
                                        const handleOpenSender = () => {
                                            if (isAgentMessage) {
                                                navigateToAgentInstallPage(username);
                                                return;
                                            }
                                            navigateToUserProfile(messageSenderId);
                                        };
                                        
                                        // Get profile picture with multiple fallbacks
                                        const senderProfilePicture = (msg.userId && typeof msg.userId === 'object' && msg.userId.profilePicture)
                                            || msg.profile_picture
                                            || msg.profilePicture
                                            || null;
                                        const humanMessageAvatar = pickPreferredAvatarValue(
                                            messageSenderId && currentUser?._id?.toString?.() === String(messageSenderId) ? currentUser?.profilePicture : null,
                                            senderProfilePicture,
                                        );
                                        const agentMessageAvatar = pickPreferredAvatarValue(
                                            agentAvatarMap.get(normalizedUsername),
                                            matchedAgent?.profile?.iconUrl,
                                            matchedAgent?.profile?.avatarUrl,
                                            matchedAgent?.iconUrl,
                                            senderProfilePicture,
                                        );
                                        const resolvedMessageAvatar = isAgentMessage ? agentMessageAvatar : humanMessageAvatar;
                                        
                                        // Get message content with fallbacks
                                        const messageContent = msg.content || msg.text || '';

                                        // Get message type with fallback
                                        const messageType = msg.messageType || msg.message_type || 'text';

                                        // Get message timestamp with fallbacks
                                        const messageTime = msg.createdAt || msg.created_at || new Date();

                                        // Check if this is a bot message payload
                                        const botParsed = parseBotMessage(messageContent);

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
                                                        <div className="message-sender-link" onClick={handleOpenSender}>
                                                            {isAgentMessage ? (
                                                                <AgentAvatar
                                                                    username={username}
                                                                    src={getAvatarSrc(resolvedMessageAvatar)}
                                                                    size={40}
                                                                    showBadge={true}
                                                                />
                                                            ) : (
                                                                <Avatar
                                                                    src={getAvatarSrc(resolvedMessageAvatar)}
                                                                    sx={{ bgcolor: getAvatarColor(resolvedMessageAvatar || 'default') }}
                                                                >
                                                                    {displayName.charAt(0).toUpperCase()}
                                                                </Avatar>
                                                            )}
                                                        </div>
                                                    </ListItemAvatar>

                                                    <div className="message-content-wrapper">
                                                        <div className="message-user message-user-link" onClick={handleOpenSender}>
                                                            {displayName}
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

                                        if (messageType === 'system') {
                                            return (
                                                <ListItem
                                                    key={msg._id || msg.id || Date.now() + Math.random()}
                                                    className="message-item system"
                                                >
                                                    <div className="message-content-wrapper system-message-wrapper">
                                                        <div className="message-bubble system-message">
                                                            <p className="message-text system-text">{messageContent}</p>
                                                        </div>
                                                        <div className="message-time system-time">
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
                                                    <div className="message-sender-link" onClick={handleOpenSender}>
                                                        {isAgentMessage ? (
                                                            <AgentAvatar
                                                                username={username}
                                                                src={getAvatarSrc(resolvedMessageAvatar)}
                                                                size={40}
                                                                showBadge={true}
                                                            />
                                                        ) : (
                                                            <Avatar
                                                                src={getAvatarSrc(resolvedMessageAvatar)}
                                                                sx={{ bgcolor: getAvatarColor(resolvedMessageAvatar || 'default') }}
                                                            >
                                                                {displayName.charAt(0).toUpperCase()}
                                                            </Avatar>
                                                        )}
                                                    </div>
                                                </ListItemAvatar>

                                                <div className="message-content-wrapper">
                                                    <div className="message-user message-user-link" onClick={handleOpenSender}>
                                                        {displayName}
                                                        {isAgentMessage && <AgentBadge username={username} size="small" />}
                                                    </div>
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
                                                                src={normalizeUploadUrl(messageContent)}
                                                                alt="Shared"
                                                                className="message-image"
                                                                onClick={() => window.open(normalizeUploadUrl(messageContent), '_blank')}
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
                        
                        <div className="message-input-wrapper">
                            <TextField
                                fullWidth
                                placeholder={selectedFile ? 'Add a caption...' : `Message #${room?.name || 'chat'}`}
                                value={message}
                                inputRef={messageInputRef}
                                onChange={(e) => {
                                    const nextValue = e.target.value;
                                    setMessage(nextValue);
                                    updateMentionState(nextValue, e.target.selectionStart);
                                }}
                                onKeyDown={handleMessageKeyDown}
                                onClick={(e) => updateMentionState(e.target.value, e.target.selectionStart)}
                                onKeyUp={(e) => updateMentionState(e.target.value, e.target.selectionStart)}
                                variant="standard"
                                multiline
                                maxRows={5}
                                InputProps={{
                                    disableUnderline: true,
                                }}
                                className="message-input"
                            />
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
                                            {item.isAgent ? (
                                                <AgentAvatar
                                                    username={item.label}
                                                    src={item.avatar}
                                                    size={28}
                                                    showBadge={true}
                                                />
                                            ) : (
                                                <Avatar
                                                    sx={{ bgcolor: getAvatarColor(item.avatar || 'default'), width: 28, height: 28 }}
                                                >
                                                    {item.label.charAt(0).toUpperCase()}
                                                </Avatar>
                                            )}
                                            <div className="mention-item-text">
                                                <span className="mention-item-label">@{item.label}</span>
                                                <span className="mention-item-subtitle">{item.subtitle}</span>
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                        
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
