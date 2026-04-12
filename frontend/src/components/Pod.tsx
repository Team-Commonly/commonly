/* eslint-disable max-len */
import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
    Container, Typography, Box, Grid, Card, CardContent, CardActions,
    Button, TextField, Dialog, DialogTitle, DialogContent, DialogActions,
    FormControl, InputLabel, Select, MenuItem, CircularProgress, Tabs, Tab,
    AppBar, Toolbar, Avatar, Chip, Tooltip, IconButton, FormControlLabel, Switch
} from '@mui/material';
import {
    Add as AddIcon,
    Search as SearchIcon,
    People as PeopleIcon,
    Launch as LaunchIcon,
    DeleteOutline as DeleteOutlineIcon,
    Lock as LockIcon
} from '@mui/icons-material';
import axios from 'axios';
import { useAuth } from '../context/AuthContext';
import { getAvatarColor, getAvatarSrc } from '../utils/avatarUtils';
import {
    readPodLastReadAt,
    resolveLatestMessageTimestampMs,
} from '../utils/podReadState';
import PodSummary from './PodSummary';
import './Pod.css';

interface PodMember {
    _id?: string;
    username?: string;
    profilePicture?: string | null;
    isBot?: boolean;
}

interface VisibleMember extends PodMember {
    role: string;
}

interface PodCreatedBy {
    _id?: string;
    username?: string;
}

interface PodData {
    _id: string;
    name?: string;
    description?: string;
    type?: string;
    joinPolicy?: string;
    members?: (PodMember | string)[];
    createdBy?: PodCreatedBy;
    parentPod?: string | { _id?: string } | null;
}

interface AgentInfo {
    name?: string;
    instanceId?: string;
    displayName?: string;
    iconUrl?: string;
    profile?: {
        iconUrl?: string;
        avatarUrl?: string;
        displayName?: string;
    };
}

const isLikelyAgentUsername = (username: string | undefined): boolean => {
    const normalized = String(username || '').trim().toLowerCase();
    if (!normalized) return false;
    return normalized.includes('-bot')
        || normalized.endsWith('bot')
        || normalized.includes('openclaw')
        || normalized.includes('clawdbot')
        || normalized.includes('moltbot')
        || normalized.includes('agent');
};

const normalizeIdentityKey = (value: string | undefined): string =>
    String(value || '').trim().toLowerCase();

const normalizeAgentSegment = (value: string | undefined): string =>
    (value || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);

const buildAgentUsername = (agentName: string | undefined, instanceId: string | undefined): string => {
    const normalized = normalizeAgentSegment(agentName);
    const instance = normalizeAgentSegment(instanceId);
    if (!instance || instance === 'default' || instance === normalized) {
        return normalized || 'agent';
    }
    return `${normalized}-${instance}`;
};

const Pod = () => {
    const { currentUser } = useAuth();
    const [pods, setPods] = useState<PodData[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [openDialog, setOpenDialog] = useState(false);
    const [roomName, setRoomName] = useState('');
    const [roomDescription, setRoomDescription] = useState('');
    const [inviteOnly, setInviteOnly] = useState(false);
    const [parentPodId, setParentPodId] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [tabValue, setTabValue] = useState(0);
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<PodData | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);
    const [membershipFilter, setMembershipFilter] = useState('all');
    const [previewPod, setPreviewPod] = useState<PodData | null>(null);
    const [unreadByPod, setUnreadByPod] = useState<Record<string, boolean>>({});
    const [podAgentAvatarMap, setPodAgentAvatarMap] = useState<Record<string, Record<string, string>>>({});
    const [debugDmCount, setDebugDmCount] = useState(0);
    const navigate = useNavigate();
    const { podType } = useParams<{ podType?: string }>();

    const getPodType = useCallback((): string => {
        if (podType) {
            return podType;
        }
        switch (tabValue) {
            case 0: return 'chat';
            case 1: return 'study';
            case 2: return 'games';
            case 3: return 'agent-ensemble';
            case 4: return 'team';
            case 5: return 'agent-room';
            default: return 'chat';
        }
    }, [podType, tabValue]);

    useEffect(() => {
        if (podType) {
            switch (podType) {
                case 'chat': setTabValue(0); break;
                case 'study': setTabValue(1); break;
                case 'games': setTabValue(2); break;
                case 'agent-ensemble': setTabValue(3); break;
                case 'team': setTabValue(4); break;
                case 'agent-room': setTabValue(5); break;
                default: setTabValue(0);
            }
        }
    }, [podType]);

    useEffect(() => {
        const fetchPods = async () => {
            try {
                setLoading(true);
                const currentPodType = getPodType();
                const response = await axios.get(`/api/pods/${currentPodType}`);
                if (response.data && Array.isArray(response.data)) {
                    setPods(response.data);
                    setError(null);
                } else {
                    console.warn('Invalid pod data format received');
                    setPods([]);
                    setError('Failed to load pods: Invalid data format');
                }
            } catch (err) {
                console.error('Error fetching pods:', err);
                setPods([]);
                setError('Failed to load pods. Please try again later.');
            } finally {
                setLoading(false);
            }
        };
        fetchPods();
    }, [tabValue, podType, getPodType]);

    useEffect(() => {
        const fetchDebugDmCount = async () => {
            const token = localStorage.getItem('token');
            if (!token) { setDebugDmCount(0); return; }
            try {
                const response = await axios.get('/api/pods?type=agent-admin', {
                    headers: { Authorization: `Bearer ${token}` }
                });
                setDebugDmCount(Array.isArray(response.data) ? response.data.length : 0);
            } catch (err) {
                setDebugDmCount(0);
            }
        };
        fetchDebugDmCount();
    }, [currentUser?._id]);

    const isMember = useCallback((pod: PodData): boolean => {
        if (!currentUser) return false;
        return pod.members?.some(member =>
            typeof member === 'object'
                ? (member as PodMember)._id === currentUser._id
                : member === currentUser._id
        ) || false;
    }, [currentUser]);

    const filteredPods = React.useMemo(() => {
        const currentPodType = getPodType();
        return pods.filter(pod => {
            const podTypeMatch = pod.type === currentPodType;
            const podName = `${pod.name || ''}`.toLowerCase();
            const podDescription = `${pod.description || ''}`.toLowerCase();
            const normalizedQuery = searchQuery.toLowerCase();
            const searchMatch = podName.includes(normalizedQuery) || podDescription.includes(normalizedQuery);
            const joined = isMember(pod);
            const membershipMatch = membershipFilter === 'all'
                || (membershipFilter === 'joined' && joined)
                || (membershipFilter === 'discover' && !joined);
            return podTypeMatch && searchMatch && membershipMatch;
        });
    }, [pods, searchQuery, getPodType, membershipFilter, isMember]);

    const sortedPods = React.useMemo(() => {
        return [...filteredPods].sort((a, b) => {
            const aJoined = isMember(a);
            const bJoined = isMember(b);
            if (aJoined !== bJoined) return aJoined ? -1 : 1;
            return (b.members?.length || 0) - (a.members?.length || 0);
        });
    }, [filteredPods, isMember]);

    const joinedCount = React.useMemo(
        () => pods.filter((pod) => isMember(pod)).length,
        [pods, isMember]
    );

    useEffect(() => {
        const fetchUnreadState = async () => {
            if (!currentUser?._id) { setUnreadByPod({}); return; }
            const token = localStorage.getItem('token');
            if (!token) { setUnreadByPod({}); return; }
            const joinedPods = pods.filter((pod) => isMember(pod));
            if (!joinedPods.length) { setUnreadByPod({}); return; }

            const authHeaders = { headers: { Authorization: `Bearer ${token}` } };
            const nextEntries = await Promise.all(joinedPods.map(async (pod) => {
                try {
                    const response = await axios.get(`/api/messages/${pod._id}?limit=1`, authHeaders);
                    const latestTs = resolveLatestMessageTimestampMs(response.data || []);
                    const readTs = readPodLastReadAt(currentUser._id, pod._id);
                    const hasUnread = Boolean(latestTs && (!readTs || latestTs > readTs));
                    return [pod._id, hasUnread] as [string, boolean];
                } catch (err) {
                    return [pod._id, false] as [string, boolean];
                }
            }));
            setUnreadByPod(Object.fromEntries(nextEntries));
        };
        fetchUnreadState();
    }, [pods, isMember, currentUser?._id]);

    useEffect(() => {
        const fetchPodAgentAvatars = async () => {
            const token = localStorage.getItem('token');
            if (!token || !pods.length) { setPodAgentAvatarMap({}); return; }
            const authHeaders = { headers: { Authorization: `Bearer ${token}` } };
            const podMaps = await Promise.all(pods.map(async (pod) => {
                try {
                    const response = await axios.get(`/api/registry/pods/${pod._id}/agents`, authHeaders);
                    const agents: AgentInfo[] = response.data?.agents || [];
                    const avatarMap: Record<string, string> = {};
                    agents.forEach((agent) => {
                        const avatar = agent?.profile?.iconUrl
                            || agent?.profile?.avatarUrl
                            || agent?.iconUrl
                            || '';
                        if (!avatar) return;
                        const display = agent?.profile?.displayName || agent?.displayName || agent?.name || '';
                        const instanceId = agent?.instanceId || 'default';
                        const username = buildAgentUsername(agent?.name, instanceId);
                        const displaySlug = display
                            .toString().trim().toLowerCase()
                            .replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
                        const keys = [
                            username, agent?.name, display, displaySlug,
                            instanceId, `${agent?.name || ''}-${instanceId}`,
                        ];
                        keys.forEach((key) => {
                            const normalized = normalizeIdentityKey(key);
                            if (normalized) avatarMap[normalized] = avatar;
                        });
                    });
                    return [pod._id, avatarMap] as [string, Record<string, string>];
                } catch (err) {
                    return [pod._id, {}] as [string, Record<string, string>];
                }
            }));
            setPodAgentAvatarMap(Object.fromEntries(podMaps));
        };
        fetchPodAgentAvatars();
    }, [pods]);

    const getMemberRole = useCallback((pod: PodData, member: PodMember | string): string => {
        if (!member || typeof member !== 'object') return 'Member';
        const m = member as PodMember;
        if (m._id && pod?.createdBy?._id && m._id === pod.createdBy._id) return 'Admin';
        if (m.isBot || isLikelyAgentUsername(m.username)) return 'Agent';
        return 'Member';
    }, []);

    const getPodPreviewMembers = useCallback((pod: PodData) => {
        const members = Array.isArray(pod?.members)
            ? pod.members.filter((member): member is PodMember =>
                member !== null && typeof member === 'object' && !!(member as PodMember).username)
            : [];
        const ranked = members.slice().sort((a, b) => {
            const rank = (member: PodMember) => {
                const role = getMemberRole(pod, member);
                if (role === 'Admin') return 0;
                if (role === 'Agent') return 1;
                return 2;
            };
            return rank(a) - rank(b);
        });
        const visibleMembers: VisibleMember[] = ranked.slice(0, 4).map((member) => ({
            ...member,
            role: getMemberRole(pod, member),
        }));
        const overflowCount = Math.max(ranked.length - visibleMembers.length, 0);
        const roleCounts = ranked.reduce<Record<string, number>>((acc, member) => {
            const role = getMemberRole(pod, member);
            acc[role] = (acc[role] || 0) + 1;
            return acc;
        }, {});
        return { visibleMembers, overflowCount, roleCounts };
    }, [getMemberRole]);

    const handleCreateRoom = async () => {
        try {
            if (!roomName.trim()) { setError('Pod name is required'); return; }
            const podTypes = ['chat', 'study', 'games', 'agent-ensemble', 'team', 'agent-room'];
            const newPodType = podTypes[tabValue] || 'chat';
            const response = await axios.post('/api/pods', {
                name: roomName,
                description: roomDescription,
                type: newPodType,
                joinPolicy: inviteOnly ? 'invite-only' : 'open',
                ...(parentPodId ? { parentPod: parentPodId } : {}),
            }, {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            });
            setPods(prevPods => [...prevPods, response.data]);
            setOpenDialog(false);
            setRoomName('');
            setRoomDescription('');
            setInviteOnly(false);
            setParentPodId('');
            setError(null);
            const fetchPodsAfter = async () => {
                try {
                    const res = await axios.get('/api/pods', { params: { type: getPodType() } });
                    setPods(res.data);
                } catch (err) {
                    console.error('Error fetching pods after creation:', err);
                }
            };
            fetchPodsAfter();
            navigate(`/pods/${newPodType}/${response.data._id}`);
        } catch (err) {
            console.error('Error creating pod:', err);
            setError('Failed to create pod. Please try again later.');
        }
    };

    const openDeleteDialog = (pod: PodData) => {
        setDeleteTarget(pod);
        setDeleteDialogOpen(true);
    };

    const closeDeleteDialog = () => {
        setDeleteDialogOpen(false);
        setDeleteTarget(null);
    };

    const handleDeletePod = async () => {
        if (!deleteTarget) return;
        setIsDeleting(true);
        try {
            await axios.delete(`/api/pods/${deleteTarget._id}`, {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            });
            setPods((prev) => prev.filter((pod) => pod._id !== deleteTarget._id));
            closeDeleteDialog();
        } catch (err: any) {
            console.error('Error deleting pod:', err);
            setError(err.response?.data?.msg || 'Failed to delete pod. Please try again.');
        } finally {
            setIsDeleting(false);
        }
    };

    const handleJoinRoom = async (podId: string) => {
        try {
            if (!podId) {
                console.error('Cannot join room: Invalid pod ID');
                setError('Cannot join room: Invalid pod ID');
                return;
            }
            const token = localStorage.getItem('token');
            const pod = pods.find(p => p._id === podId);
            if (pod && isMember(pod)) {
                navigate(`/pods/${getPodType()}/${podId}`);
                return;
            }
            const response = await axios.post(`/api/pods/${podId}/join`, {}, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            setPods(pods.map(p => p._id === podId ? response.data : p));
            navigate(`/pods/${getPodType()}/${podId}`);
        } catch (err) {
            console.error('Error joining room:', err);
            setError('Failed to join room. Please try again later.');
        }
    };

    const handleTabChange = (_event: React.SyntheticEvent, newValue: number) => {
        setTabValue(newValue);
        const podTypes = ['chat', 'study', 'games', 'agent-ensemble', 'team', 'agent-room'];
        navigate(`/pods/${podTypes[newValue]}`);
    };

    const isAgentAdminView = getPodType() === 'agent-admin';

    return (
        <Container
            maxWidth="lg"
            disableGutters
            sx={{ px: { xs: 2, sm: 3, md: 4 } }}
            className="pod-container"
        >
            <AppBar position="static" color="default" className="pod-app-bar">
                <Toolbar sx={{ flexWrap: { xs: 'wrap', sm: 'nowrap' }, gap: 1.5 }}>
                    <Box className="pod-header-title-wrap">
                        <Typography variant="h6" className="pod-title">
                            {isAgentAdminView ? 'Agent DMs' : 'Pods'}
                        </Typography>
                        <Typography variant="body2" className="pod-subtitle">
                            {isAgentAdminView
                                ? 'Direct message conversations with your installed agents.'
                                : 'Browse, preview, and join conversations before entering.'}
                        </Typography>
                    </Box>
                    <Box className="pod-stat-chips">
                        <Chip label={`${pods.length} total`} size="small" className="pod-stat-chip" />
                        <Chip label={`${joinedCount} joined`} size="small" className="pod-stat-chip" />
                        <Chip label={`${filteredPods.length} shown`} size="small" className="pod-stat-chip" />
                        {!isAgentAdminView && (
                            <Chip
                                label={`Agent Admin ${debugDmCount > 0 ? `(${debugDmCount})` : ''}`}
                                size="small"
                                className="pod-stat-chip"
                                onClick={() => navigate('/pods/agent-admin')}
                                clickable
                            />
                        )}
                    </Box>
                    <Box sx={{ flexGrow: 1 }} />
                    <Box className="pod-search" sx={{ width: { xs: '100%', sm: 260 } }}>
                        <TextField
                            placeholder="Search pods..."
                            variant="outlined"
                            size="small"
                            fullWidth
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            InputProps={{ startAdornment: <SearchIcon color="action" /> }}
                        />
                    </Box>
                    <Box sx={{ ml: { xs: 0, sm: 2 }, width: { xs: '100%', sm: 'auto' } }}>
                        <Button
                            fullWidth
                            variant="contained"
                            color="primary"
                            startIcon={<AddIcon />}
                            onClick={() => setOpenDialog(true)}
                            className="create-room-button"
                            disabled={isAgentAdminView}
                        >
                            Create Room
                        </Button>
                    </Box>
                </Toolbar>

                {!isAgentAdminView && (
                    <>
                        <Tabs
                            value={tabValue}
                            onChange={handleTabChange}
                            indicatorColor="primary"
                            textColor="primary"
                            centered
                            variant="scrollable"
                            allowScrollButtonsMobile
                            className="pod-tabs"
                        >
                            <Tab label="Chat" className="pod-tab" />
                            <Tab label="Study" className="pod-tab" />
                            <Tab label="Games" className="pod-tab" />
                            <Tab label="Ensemble" className="pod-tab" />
                            <Tab label="Teams" className="pod-tab" />
                            <Tab label="Agent DMs" className="pod-tab" />
                        </Tabs>
                        <Box className="pod-membership-filter-row">
                            <Button size="small" variant={membershipFilter === 'all' ? 'contained' : 'outlined'} className="pod-filter-button" onClick={() => setMembershipFilter('all')}>All</Button>
                            <Button size="small" variant={membershipFilter === 'joined' ? 'contained' : 'outlined'} className="pod-filter-button" onClick={() => setMembershipFilter('joined')}>Joined</Button>
                            <Button size="small" variant={membershipFilter === 'discover' ? 'contained' : 'outlined'} className="pod-filter-button" onClick={() => setMembershipFilter('discover')}>Discover</Button>
                        </Box>
                    </>
                )}
            </AppBar>

            {loading ? (
                <Box className="pod-loading"><CircularProgress /></Box>
            ) : error ? (
                <Box className="pod-error"><Typography color="error">{error}</Typography></Box>
            ) : (
                <Grid
                    container
                    spacing={{ xs: 0, sm: 3 }}
                    className="pod-grid"
                    sx={{ justifyContent: { xs: 'center', sm: 'flex-start' } }}
                >
                    {sortedPods.length === 0 ? (
                        <Grid item xs={12}>
                            <Box className="pod-empty">
                                <PeopleIcon sx={{ fontSize: 60, mb: 2 }} />
                                <Typography variant="h5" gutterBottom>
                                    {isAgentAdminView ? 'No agent DMs yet' : 'No pods found in this category'}
                                </Typography>
                                <Typography variant="body1" color="textSecondary" paragraph>
                                    {isAgentAdminView
                                        ? 'Open a DM from the Agents page.'
                                        : getPodType() === 'agent-ensemble'
                                        ? 'Create a new agent ensemble pod to orchestrate multi-agent conversations.'
                                        : 'Create a new pod to start chatting with others!'}
                                </Typography>
                                {!isAgentAdminView && (
                                    <Button variant="contained" color="primary" size="large" startIcon={<AddIcon />} onClick={() => setOpenDialog(true)}>
                                        Create New Pod
                                    </Button>
                                )}
                            </Box>
                        </Grid>
                    ) : (
                        (() => {
                            const byParent = sortedPods.reduce<Record<string, PodData[]>>((acc, p) => {
                                if (p.parentPod) {
                                    const pid = typeof p.parentPod === 'object' ? (p.parentPod as { _id?: string })?._id || '' : p.parentPod;
                                    acc[pid] = [...(acc[pid] || []), p];
                                }
                                return acc;
                            }, {});
                            const renderCard = (pod: PodData, isChild: boolean) => {
                                const canDeletePod = Boolean(currentUser && (
                                    currentUser.role === 'admin'
                                    || (pod.createdBy && pod.createdBy._id === currentUser._id)
                                ));
                                const joined = isMember(pod);
                                const hasUnread = joined && Boolean(unreadByPod[pod._id]);
                                const { visibleMembers, overflowCount, roleCounts } = getPodPreviewMembers(pod);
                                const roleSummary = [
                                    roleCounts.Admin ? `${roleCounts.Admin} admin` : null,
                                    roleCounts.Agent ? `${roleCounts.Agent} agent${roleCounts.Agent > 1 ? 's' : ''}` : null,
                                    roleCounts.Member ? `${roleCounts.Member} member${roleCounts.Member > 1 ? 's' : ''}` : null,
                                ].filter(Boolean).join(' • ');
                                return (
                                    <Grid item xs={12} sm={6} md={4} key={pod._id} sx={isChild ? { pl: { sm: 4 } } : undefined}>
                                        <Card className={`pod-card ${hasUnread ? 'pod-card-unread' : ''}`} sx={isChild ? { borderLeft: '3px solid', borderColor: 'primary.light' } : undefined}>
                                            <CardContent sx={{ p: 2, pb: 1.5 }}>
                                                <Box className="pod-card-meta">
                                                    <Chip size="small" className="pod-card-type-chip" label={(pod.type || getPodType()).replace('-', ' ')} />
                                                    <Box className="pod-card-meta-status">
                                                        {pod.joinPolicy === 'invite-only' && (
                                                            <Tooltip title="Invite-only" arrow>
                                                                <LockIcon fontSize="small" sx={{ color: 'text.secondary', mr: 0.5 }} />
                                                            </Tooltip>
                                                        )}
                                                        {hasUnread ? <Chip size="small" className="pod-card-unread-chip" label="New messages" /> : null}
                                                        {joined ? <Chip size="small" className="pod-card-joined-chip" label="Joined" /> : null}
                                                        {!isChild && byParent[pod._id]?.length > 0 && (
                                                            <Chip size="small" label={`${byParent[pod._id].length} sub-pod${byParent[pod._id].length > 1 ? 's' : ''}`} sx={{ ml: 0.5 }} />
                                                        )}
                                                    </Box>
                                                </Box>
                                                <PodSummary
                                                    podId={pod._id}
                                                    title={pod.name}
                                                    originalDescription={pod.description}
                                                />
                                                <Box className="pod-members-preview">
                                                    <Box className="pod-members-stack">
                                                        {visibleMembers.map((member, index) => {
                                                            const registryAgentAvatar = podAgentAvatarMap[pod._id]?.[normalizeIdentityKey(member.username)] || null;
                                                            const preferredAvatarValue = member.role === 'Agent'
                                                                ? (registryAgentAvatar || member.profilePicture)
                                                                : member.profilePicture;
                                                            const avatarSrc = getAvatarSrc(preferredAvatarValue);
                                                            const roleClass = member.role.toLowerCase();
                                                            return (
                                                                <Tooltip key={`${pod._id}-${member._id || member.username}`} title={`${member.role} • @${member.username}`} arrow>
                                                                    <Avatar
                                                                        className={`pod-member-avatar pod-member-avatar-${roleClass}`}
                                                                        src={avatarSrc || undefined}
                                                                        sx={{ bgcolor: getAvatarColor(member.profilePicture || 'default'), zIndex: 10 - index }}
                                                                    >
                                                                        {member.username?.charAt(0).toUpperCase()}
                                                                    </Avatar>
                                                                </Tooltip>
                                                            );
                                                        })}
                                                        {overflowCount > 0 && (
                                                            <Avatar className="pod-member-avatar pod-member-avatar-overflow">+{overflowCount}</Avatar>
                                                        )}
                                                    </Box>
                                                    <Typography variant="caption" className="pod-member-role-summary">
                                                        {roleSummary || 'No members yet'}
                                                    </Typography>
                                                </Box>
                                            </CardContent>
                                            <CardActions className="pod-card-actions" sx={{ px: 2, py: 1.5 }}>
                                                <Tooltip title="Preview" arrow>
                                                    <IconButton aria-label="Preview pod" className="pod-action-icon-button" onClick={() => setPreviewPod(pod)}>
                                                        <LaunchIcon fontSize="small" />
                                                    </IconButton>
                                                </Tooltip>
                                                <Tooltip title={!joined && pod.joinPolicy === 'invite-only' ? 'Invite-only — ask the pod creator to add you' : ''} arrow>
                                                    <span style={{ flex: 1, minWidth: 0 }}>
                                                        <Button variant="contained" color="primary" fullWidth className="pod-primary-action" onClick={() => handleJoinRoom(pod._id)} disabled={!joined && pod.joinPolicy === 'invite-only'}>
                                                            {joined ? 'Open Chat' : 'Join Room'}
                                                        </Button>
                                                    </span>
                                                </Tooltip>
                                                {canDeletePod && (
                                                    <Tooltip title="Delete" arrow>
                                                        <IconButton aria-label="Delete pod" className="pod-action-icon-button pod-action-delete-button" onClick={() => openDeleteDialog(pod)}>
                                                            <DeleteOutlineIcon fontSize="small" />
                                                        </IconButton>
                                                    </Tooltip>
                                                )}
                                            </CardActions>
                                        </Card>
                                    </Grid>
                                );
                            };
                            return sortedPods.filter(p => !p.parentPod).flatMap(pod => [
                                renderCard(pod, false),
                                ...(byParent[pod._id] || []).map(c => renderCard(c, true)),
                            ]);
                        })()
                    )}
                </Grid>
            )}

            {/* Create Room Dialog */}
            <Dialog open={openDialog} onClose={() => setOpenDialog(false)} maxWidth="sm" fullWidth>
                <DialogTitle>
                    <Box display="flex" alignItems="center">
                        <AddIcon sx={{ mr: 1, color: 'primary.main' }} />
                        Create a New Pod
                    </Box>
                </DialogTitle>
                <DialogContent>
                    <Typography variant="body2" color="textSecondary" sx={{ mb: 2 }}>
                        Create a new pod to chat with others. Pods are spaces where you can discuss topics, share ideas, and connect with people.
                    </Typography>
                    <TextField autoFocus margin="dense" label="Pod Name" type="text" fullWidth value={roomName} onChange={(e) => setRoomName(e.target.value)} sx={{ mb: 2 }} placeholder="E.g., JavaScript Developers, Book Club, etc." />
                    <TextField margin="dense" label="Description" type="text" fullWidth multiline rows={3} value={roomDescription} onChange={(e) => setRoomDescription(e.target.value)} sx={{ mb: 2 }} placeholder="Describe what this pod is about..." />
                    <FormControl fullWidth sx={{ mb: 2 }}>
                        <InputLabel>Pod Type</InputLabel>
                        <Select value={tabValue} onChange={(e) => setTabValue(Number(e.target.value))}>
                            <MenuItem value={0}>Chat</MenuItem>
                            <MenuItem value={1}>Study</MenuItem>
                            <MenuItem value={2}>Games</MenuItem>
                            <MenuItem value={3}>Agent Ensemble</MenuItem>
                            <MenuItem value={4}>Team</MenuItem>
                        </Select>
                    </FormControl>
                    <FormControl fullWidth sx={{ mb: 2 }}>
                        <InputLabel>Parent Pod (optional)</InputLabel>
                        <Select value={parentPodId} onChange={(e) => setParentPodId(e.target.value as string)} label="Parent Pod (optional)">
                            <MenuItem value="">None (top-level pod)</MenuItem>
                            {pods.filter(p => !p.parentPod).map(p => (
                                <MenuItem key={p._id} value={p._id}>{p.name}</MenuItem>
                            ))}
                        </Select>
                    </FormControl>
                    <FormControlLabel
                        control={<Switch checked={inviteOnly} onChange={(e) => setInviteOnly(e.target.checked)} color="primary" />}
                        label={
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                <LockIcon fontSize="small" sx={{ color: inviteOnly ? 'primary.main' : 'text.disabled' }} />
                                <Typography variant="body2">Invite-only {inviteOnly ? '— only you and admins can add members' : ''}</Typography>
                            </Box>
                        }
                        sx={{ mb: 1 }}
                    />
                </DialogContent>
                <DialogActions sx={{ px: 3, pb: 3 }}>
                    <Button onClick={() => setOpenDialog(false)} color="inherit" variant="outlined">Cancel</Button>
                    <Button onClick={handleCreateRoom} color="primary" variant="contained" disabled={!roomName.trim()}>Create Pod</Button>
                </DialogActions>
            </Dialog>

            <Dialog open={Boolean(previewPod)} onClose={() => setPreviewPod(null)} maxWidth="sm" fullWidth>
                <DialogTitle>{previewPod?.name || 'Pod Preview'}</DialogTitle>
                <DialogContent>
                    <Box className="pod-preview-body">
                        <Typography variant="body2" color="textSecondary">{previewPod?.description || 'No description yet.'}</Typography>
                        <Box className="pod-preview-meta">
                            <Chip size="small" label={`Type: ${(previewPod?.type || '').replace('-', ' ') || getPodType()}`} />
                            <Chip size="small" icon={<PeopleIcon />} label={`${previewPod?.members?.length || 0} members`} />
                            <Chip size="small" label={`Creator: @${previewPod?.createdBy?.username || 'unknown'}`} />
                        </Box>
                    </Box>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setPreviewPod(null)}>Close</Button>
                    <Button color="primary" variant="contained" onClick={() => {
                        if (!previewPod?._id) return;
                        handleJoinRoom(previewPod._id);
                        setPreviewPod(null);
                    }}>
                        {previewPod && isMember(previewPod) ? 'Open from Preview' : 'Join from Preview'}
                    </Button>
                </DialogActions>
            </Dialog>

            <Dialog open={deleteDialogOpen} onClose={closeDeleteDialog}>
                <DialogTitle>Delete Pod</DialogTitle>
                <DialogContent>
                    <Typography>Delete &quot;{deleteTarget?.name}&quot;? This will remove messages, assets, and agent installs for the pod.</Typography>
                </DialogContent>
                <DialogActions>
                    <Button onClick={closeDeleteDialog}>Cancel</Button>
                    <Button color="error" variant="contained" onClick={handleDeletePod} disabled={isDeleting}>
                        {isDeleting ? 'Deleting...' : 'Delete'}
                    </Button>
                </DialogActions>
            </Dialog>
        </Container>
    );
};

export default Pod;
