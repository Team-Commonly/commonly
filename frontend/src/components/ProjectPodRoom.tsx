// @ts-nocheck
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Add as AddIcon,
  AssignmentTurnedIn as CompleteIcon,
  Edit as EditIcon,
  Flag as FlagIcon,
  Handyman as TaskIcon,
  PlayArrow as TakeTaskIcon,
} from '@mui/icons-material';
import axios from 'axios';
import { useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { getAvatarColor, getAvatarSrc } from '../utils/avatarUtils';
import MessageContent from './common/MessageContent';
import UnifiedComposer from './common/UnifiedComposer';

const PROJECT_TAB_CHAT = 'chat';
const PROJECT_TAB_TASKS = 'tasks';
const TASK_FILTERS = ['all', 'mine', 'human', 'agent', 'blocked', 'done'];

const normalizeIdentityKey = (value) => String(value || '').trim().toLowerCase();
const normalizeAgentSegment = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
const buildAgentUsername = (agentName, instanceId) => {
  const base = normalizeAgentSegment(agentName);
  const instance = normalizeAgentSegment(instanceId);
  if (!instance || instance === 'default' || instance === base) return base || 'agent';
  return `${base}-${instance}`;
};
const formatShortDate = (value) => {
  if (!value) return 'No due date';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'No due date';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
const formatDateTime = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
const taskStatusLabel = (status) => {
  switch (status) {
    case 'claimed': return 'In Progress';
    case 'blocked': return 'Blocked';
    case 'done': return 'Done';
    default: return 'Todo';
  }
};
const taskStatusColor = (status) => {
  switch (status) {
    case 'claimed': return 'info';
    case 'blocked': return 'warning';
    case 'done': return 'success';
    default: return 'default';
  }
};
const projectStatusColor = (status) => {
  switch (status) {
    case 'on-track': return 'success';
    case 'at-risk': return 'warning';
    case 'blocked': return 'error';
    case 'complete': return 'primary';
    default: return 'default';
  }
};

const ProjectPodRoom = () => {
  const { roomId } = useParams();
  const { currentUser } = useAuth();
  const { socket, connected, joinPod, leavePod, sendMessage } = useSocket();
  const [activeTab, setActiveTab] = useState(PROJECT_TAB_CHAT);
  const [room, setRoom] = useState(null);
  const [messages, setMessages] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [podAgents, setPodAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [taskFilter, setTaskFilter] = useState('all');
  const [taskSearch, setTaskSearch] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState(null);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [progressOpen, setProgressOpen] = useState(false);
  const [blockerOpen, setBlockerOpen] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [projectForm, setProjectForm] = useState({
    name: '',
    description: '',
    goal: '',
    scope: '',
    successCriteriaText: '',
    status: 'planning',
    dueDate: '',
    keyLinksText: '',
  });
  const [newTaskForm, setNewTaskForm] = useState({
    title: '',
    description: '',
    assigneeKey: '',
    priority: 'medium',
    dueDate: '',
  });
  const [assignKey, setAssignKey] = useState('');
  const [progressForm, setProgressForm] = useState({
    text: '',
    progressPercent: '',
    nextStep: '',
  });
  const [blockerForm, setBlockerForm] = useState({
    reason: '',
    waitingOn: '',
    severity: 'medium',
  });
  const [completeNotes, setCompleteNotes] = useState('');
  const messagesEndRef = useRef(null);

  const token = localStorage.getItem('token');
  const authHeaders = useMemo(() => ({
    headers: { Authorization: `Bearer ${token}` },
  }), [token]);

  const agentIdentityMap = useMemo(() => {
    const displayMap = new Map();
    const avatarMap = new Map();
    (podAgents || []).forEach((agent) => {
      const display = agent?.profile?.displayName || agent?.displayName || agent?.instanceId || agent?.name;
      const avatar = agent?.profile?.iconUrl || agent?.profile?.avatarUrl || agent?.iconUrl || '';
      const username = buildAgentUsername(agent?.name, agent?.instanceId);
      const keys = [
        username,
        agent?.name,
        display,
        agent?.instanceId,
        `${agent?.name || ''}-${agent?.instanceId || 'default'}`,
      ];
      keys.forEach((key) => {
        const normalized = normalizeIdentityKey(key);
        if (!normalized) return;
        displayMap.set(normalized, display);
        if (avatar) avatarMap.set(normalized, avatar);
      });
    });
    return { displayMap, avatarMap };
  }, [podAgents]);

  const assignmentOptions = useMemo(() => {
    const humans = (room?.members || [])
      .filter((member) => member && typeof member === 'object' && member._id && member.username)
      .map((member) => ({
        key: `human:${member._id}`,
        label: member.username,
        type: 'human',
        assignee: member.username,
        assigneeRef: member._id,
      }));
    const agents = (podAgents || []).map((agent) => ({
      key: `agent:${agent.instanceId || 'default'}`,
      label: agent.profile?.displayName || agent.displayName || agent.instanceId || agent.name,
      type: 'agent',
      assignee: agent.profile?.displayName || agent.displayName || agent.instanceId || agent.name,
      assigneeRef: agent.instanceId || 'default',
    }));
    return [...humans, ...agents];
  }, [podAgents, room?.members]);

  const selectedTask = useMemo(
    () => tasks.find((task) => task.taskId === selectedTaskId) || null,
    [tasks, selectedTaskId],
  );

  const openTaskCount = useMemo(
    () => tasks.filter((task) => task.status !== 'done').length,
    [tasks],
  );
  const blockedTaskCount = useMemo(
    () => tasks.filter((task) => task.status === 'blocked' || task.blocker?.open).length,
    [tasks],
  );

  const filteredTasks = useMemo(() => {
    const normalizedQuery = taskSearch.trim().toLowerCase();
    return tasks.filter((task) => {
      const matchesQuery = !normalizedQuery
        || String(task.title || '').toLowerCase().includes(normalizedQuery)
        || String(task.description || '').toLowerCase().includes(normalizedQuery)
        || String(task.assignee || '').toLowerCase().includes(normalizedQuery)
        || String(task.taskId || '').toLowerCase().includes(normalizedQuery);
      if (!matchesQuery) return false;
      switch (taskFilter) {
        case 'mine':
          return task.assigneeRef === currentUser?._id || normalizeIdentityKey(task.assignee) === normalizeIdentityKey(currentUser?.username);
        case 'human':
          return task.assigneeType === 'human';
        case 'agent':
          return task.assigneeType === 'agent';
        case 'blocked':
          return task.status === 'blocked' || task.blocker?.open;
        case 'done':
          return task.status === 'done';
        default:
          return true;
      }
    });
  }, [currentUser?._id, currentUser?.username, taskFilter, taskSearch, tasks]);

  const projectOwners = useMemo(() => {
    const ownerIds = new Set((room?.projectMeta?.ownerIds || []).map((id) => String(id)));
    return (room?.members || []).filter((member) => ownerIds.has(String(member?._id)));
  }, [room?.members, room?.projectMeta?.ownerIds]);

  const syncTask = useCallback((incomingTask) => {
    if (!incomingTask) return;
    setTasks((prev) => {
      const existingIndex = prev.findIndex((task) => task.taskId === incomingTask.taskId);
      if (existingIndex === -1) return [...prev, incomingTask];
      const next = prev.slice();
      next[existingIndex] = incomingTask;
      return next;
    });
    setSelectedTaskId((prev) => prev || incomingTask.taskId);
  }, []);

  const loadRoom = useCallback(async () => {
    if (!roomId || !token) return;
    setLoading(true);
    try {
      const [podRes, messageRes, tasksRes, agentsRes] = await Promise.all([
        axios.get(`/api/pods/project/${roomId}`, authHeaders),
        axios.get(`/api/messages/${roomId}?limit=100`, authHeaders),
        axios.get(`/api/v1/tasks/${roomId}`, authHeaders),
        axios.get(`/api/registry/pods/${roomId}/agents`, authHeaders),
      ]);
      setRoom(podRes.data);
      setMessages(messageRes.data || []);
      setTasks(tasksRes.data?.tasks || []);
      setPodAgents(agentsRes.data?.agents || []);
      setSelectedTaskId((tasksRes.data?.tasks || [])[0]?.taskId || null);
      setError('');
    } catch (err) {
      console.error('Failed to load project pod:', err);
      setError('Failed to load project pod.');
    } finally {
      setLoading(false);
    }
  }, [authHeaders, roomId, token]);

  useEffect(() => {
    loadRoom();
  }, [loadRoom]);

  useEffect(() => {
    if (!selectedTaskId && filteredTasks.length > 0) {
      setSelectedTaskId(filteredTasks[0].taskId);
      return;
    }
    if (selectedTaskId && filteredTasks.length > 0 && !filteredTasks.some((task) => task.taskId === selectedTaskId)) {
      setSelectedTaskId(filteredTasks[0].taskId);
    }
  }, [filteredTasks, selectedTaskId]);

  useEffect(() => {
    if (!connected || !roomId) return undefined;
    joinPod(roomId);

    const handleNewMessage = (incomingMessage) => {
      if (incomingMessage?.podId && String(incomingMessage.podId) !== String(roomId)) return;
      setMessages((prev) => {
        const optimisticIndex = prev.findIndex((message) => !message._id && message.content === incomingMessage.content);
        if (optimisticIndex >= 0) {
          const next = prev.slice();
          next[optimisticIndex] = incomingMessage;
          return next;
        }
        return [...prev, incomingMessage];
      });
    };

    const handleTaskUpdated = (payload) => {
      if (!payload?.task) return;
      if (payload.podId && String(payload.podId) !== String(roomId)) return;
      syncTask(payload.task);
    };

    socket?.on('newMessage', handleNewMessage);
    socket?.on('task_updated', handleTaskUpdated);

    return () => {
      leavePod(roomId);
      socket?.off('newMessage', handleNewMessage);
      socket?.off('task_updated', handleTaskUpdated);
    };
  }, [connected, joinPod, leavePod, roomId, socket, syncTask]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSendProjectMessage = useCallback((payload) => {
    if (!payload?.content?.trim() || !roomId) return;
    const optimisticMessage = {
      id: Date.now(),
      content: payload.content,
      messageType: 'text',
      userId: {
        _id: currentUser?._id,
        username: currentUser?.username,
        profilePicture: currentUser?.profilePicture,
      },
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticMessage]);
    sendMessage(roomId, payload.content, 'text');
  }, [currentUser?._id, currentUser?.profilePicture, currentUser?.username, roomId, sendMessage]);

  const openProjectDialog = () => {
    setProjectForm({
      name: room?.name || '',
      description: room?.description || '',
      goal: room?.projectMeta?.goal || '',
      scope: room?.projectMeta?.scope || '',
      successCriteriaText: (room?.projectMeta?.successCriteria || []).join('\n'),
      status: room?.projectMeta?.status || 'planning',
      dueDate: room?.projectMeta?.dueDate ? new Date(room.projectMeta.dueDate).toISOString().slice(0, 10) : '',
      keyLinksText: (room?.projectMeta?.keyLinks || []).map((link) => `${link.label || ''} | ${link.url || ''}`.trim()).join('\n'),
    });
    setProjectDialogOpen(true);
  };

  const handleSaveProject = async () => {
    if (!roomId) return;
    setSaving(true);
    try {
      const keyLinks = projectForm.keyLinksText
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [label, url] = line.includes('|') ? line.split('|') : [line, line];
          return { label: String(label || '').trim(), url: String(url || '').trim() };
        });
      const response = await axios.patch(`/api/pods/${roomId}`, {
        name: projectForm.name,
        description: projectForm.description,
        projectMeta: {
          goal: projectForm.goal,
          scope: projectForm.scope,
          successCriteria: projectForm.successCriteriaText.split('\n').map((item) => item.trim()).filter(Boolean),
          status: projectForm.status,
          dueDate: projectForm.dueDate || null,
          keyLinks,
          ownerIds: room?.projectMeta?.ownerIds || [],
        },
      }, authHeaders);
      setRoom(response.data);
      setProjectDialogOpen(false);
    } catch (err) {
      console.error('Failed to save project:', err);
      setError('Failed to save project details.');
    } finally {
      setSaving(false);
    }
  };

  const handleCreateTask = async () => {
    if (!roomId || !newTaskForm.title.trim()) return;
    setSaving(true);
    try {
      const assigneeOption = assignmentOptions.find((option) => option.key === newTaskForm.assigneeKey);
      const response = await axios.post(`/api/v1/tasks/${roomId}`, {
        title: newTaskForm.title.trim(),
        description: newTaskForm.description.trim(),
        assignee: assigneeOption?.assignee || undefined,
        assigneeType: assigneeOption?.type || null,
        assigneeRef: assigneeOption?.assigneeRef || null,
        priority: newTaskForm.priority,
        dueDate: newTaskForm.dueDate || null,
      }, authHeaders);
      syncTask(response.data.task);
      setNewTaskOpen(false);
      setNewTaskForm({ title: '', description: '', assigneeKey: '', priority: 'medium', dueDate: '' });
    } catch (err) {
      console.error('Failed to create task:', err);
      setError('Failed to create task.');
    } finally {
      setSaving(false);
    }
  };

  const handleTakeTask = async () => {
    if (!roomId || !selectedTask) return;
    setSaving(true);
    try {
      const response = await axios.patch(`/api/v1/tasks/${roomId}/${selectedTask.taskId}`, {
        assignee: currentUser?.username,
        assigneeType: 'human',
        assigneeRef: currentUser?._id,
        status: selectedTask.status === 'done' ? 'done' : 'claimed',
      }, authHeaders);
      syncTask(response.data.task);
    } catch (err) {
      console.error('Failed to take task:', err);
      setError('Failed to take task.');
    } finally {
      setSaving(false);
    }
  };

  const handleAssignTask = async () => {
    if (!roomId || !selectedTask) return;
    const assigneeOption = assignmentOptions.find((option) => option.key === assignKey);
    if (!assigneeOption) return;
    setSaving(true);
    try {
      const response = await axios.patch(`/api/v1/tasks/${roomId}/${selectedTask.taskId}`, {
        assignee: assigneeOption.assignee,
        assigneeType: assigneeOption.type,
        assigneeRef: assigneeOption.assigneeRef,
      }, authHeaders);
      syncTask(response.data.task);
      setAssignOpen(false);
      setAssignKey('');
    } catch (err) {
      console.error('Failed to assign task:', err);
      setError('Failed to assign task.');
    } finally {
      setSaving(false);
    }
  };

  const handlePostProgress = async () => {
    if (!roomId || !selectedTask || !progressForm.text.trim()) return;
    setSaving(true);
    try {
      const progressPercent = progressForm.progressPercent === '' ? undefined : Number(progressForm.progressPercent);
      const response = await axios.post(`/api/v1/tasks/${roomId}/${selectedTask.taskId}/updates`, {
        text: progressForm.text.trim(),
        kind: 'progress',
        progressPercent,
        nextStep: progressForm.nextStep.trim() || undefined,
      }, authHeaders);
      syncTask(response.data.task);
      if (selectedTask.status === 'pending') {
        const patchResponse = await axios.patch(`/api/v1/tasks/${roomId}/${selectedTask.taskId}`, { status: 'claimed' }, authHeaders);
        syncTask(patchResponse.data.task);
      }
      setProgressOpen(false);
      setProgressForm({ text: '', progressPercent: '', nextStep: '' });
    } catch (err) {
      console.error('Failed to post progress:', err);
      setError('Failed to post progress.');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveBlocker = async () => {
    if (!roomId || !selectedTask || !blockerForm.reason.trim()) return;
    setSaving(true);
    try {
      const blocker = {
        open: true,
        reason: blockerForm.reason.trim(),
        waitingOn: blockerForm.waitingOn.trim() || null,
        severity: blockerForm.severity,
        openedAt: new Date().toISOString(),
        openedBy: currentUser?.username || currentUser?._id || 'unknown',
        resolvedAt: null,
      };
      const [patchResponse] = await Promise.all([
        axios.patch(`/api/v1/tasks/${roomId}/${selectedTask.taskId}`, {
          status: 'blocked',
          blocker,
        }, authHeaders),
        axios.post(`/api/v1/tasks/${roomId}/${selectedTask.taskId}/updates`, {
          text: blockerForm.reason.trim(),
          kind: 'blocker',
          nextStep: blockerForm.waitingOn.trim() || undefined,
        }, authHeaders),
      ]);
      syncTask(patchResponse.data.task);
      setBlockerOpen(false);
      setBlockerForm({ reason: '', waitingOn: '', severity: 'medium' });
    } catch (err) {
      console.error('Failed to save blocker:', err);
      setError('Failed to raise blocker.');
    } finally {
      setSaving(false);
    }
  };

  const handleClearBlocker = async () => {
    if (!roomId || !selectedTask) return;
    setSaving(true);
    try {
      const response = await axios.patch(`/api/v1/tasks/${roomId}/${selectedTask.taskId}`, {
        status: 'claimed',
        blocker: {
          open: false,
          reason: null,
          waitingOn: null,
          severity: selectedTask?.blocker?.severity || 'medium',
          openedAt: selectedTask?.blocker?.openedAt || null,
          openedBy: selectedTask?.blocker?.openedBy || null,
          resolvedAt: new Date().toISOString(),
        },
      }, authHeaders);
      syncTask(response.data.task);
    } catch (err) {
      console.error('Failed to clear blocker:', err);
      setError('Failed to clear blocker.');
    } finally {
      setSaving(false);
    }
  };

  const handleCompleteTask = async () => {
    if (!roomId || !selectedTask) return;
    setSaving(true);
    try {
      const response = await axios.post(`/api/v1/tasks/${roomId}/${selectedTask.taskId}/complete`, {
        notes: completeNotes.trim() || undefined,
      }, authHeaders);
      syncTask(response.data.task);
      setCompleteOpen(false);
      setCompleteNotes('');
    } catch (err) {
      console.error('Failed to complete task:', err);
      setError('Failed to complete task.');
    } finally {
      setSaving(false);
    }
  };

  const renderMessageAuthor = (message) => {
    const username = message?.userId?.username || message?.username || 'unknown';
    return agentIdentityMap.displayMap.get(normalizeIdentityKey(username)) || username;
  };

  const renderMessageAvatar = (message) => {
    const username = message?.userId?.username || message?.username || '';
    return agentIdentityMap.avatarMap.get(normalizeIdentityKey(username))
      || message?.userId?.profilePicture
      || message?.profilePicture
      || '';
  };

  if (loading) {
    return (
      <Box sx={{ minHeight: '70vh', display: 'grid', placeItems: 'center' }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error && !room) {
    return <Alert severity="error">{error}</Alert>;
  }

  return (
    <Box sx={{ px: { xs: 2, md: 3 }, py: { xs: 2, md: 3 }, minHeight: '100vh', background: 'linear-gradient(180deg, #0f172a 0%, #111827 100%)' }}>
      <Paper sx={{ p: { xs: 2, md: 3 }, borderRadius: 4, backgroundColor: '#101826', border: '1px solid rgba(148,163,184,0.18)' }}>
        <Stack spacing={2.5}>
          <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" spacing={2}>
            <Box>
              <Typography variant="overline" sx={{ color: '#93c5fd', letterSpacing: 1.4 }}>
                Project Pod
              </Typography>
              <Typography variant="h3" sx={{ fontSize: { xs: '1.8rem', md: '2.6rem' }, fontWeight: 800, color: '#f8fafc' }}>
                {room?.name}
              </Typography>
              <Typography sx={{ mt: 1, maxWidth: 820, color: '#cbd5e1', fontSize: '1rem' }}>
                {room?.description || room?.projectMeta?.goal || 'Project workspace for people and agents.'}
              </Typography>
            </Box>
            <Stack direction={{ xs: 'row', md: 'column' }} spacing={1} justifyContent="flex-start" alignItems={{ xs: 'stretch', md: 'flex-end' }}>
              <Button variant="contained" startIcon={<AddIcon />} onClick={() => setNewTaskOpen(true)}>
                New Task
              </Button>
              <Button variant="outlined" startIcon={<EditIcon />} onClick={openProjectDialog}>
                Edit Project
              </Button>
            </Stack>
          </Stack>

          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <Chip color={projectStatusColor(room?.projectMeta?.status)} label={`Status: ${room?.projectMeta?.status || 'planning'}`} />
            <Chip label={`Due: ${formatShortDate(room?.projectMeta?.dueDate)}`} />
            <Chip label={`Open tasks: ${openTaskCount}`} />
            <Chip label={`Blocked: ${blockedTaskCount}`} color={blockedTaskCount > 0 ? 'warning' : 'default'} />
            <Chip label={`Members: ${room?.members?.length || 0}`} />
            <Chip label={`Agents: ${podAgents.length}`} />
          </Stack>

          {error ? <Alert severity="error" onClose={() => setError('')}>{error}</Alert> : null}

          <Tabs
            value={activeTab}
            onChange={(_event, nextValue) => setActiveTab(nextValue)}
            sx={{
              '& .MuiTabs-indicator': { backgroundColor: '#f59e0b', height: 3 },
              '& .MuiTab-root': { color: '#cbd5e1', textTransform: 'none', fontWeight: 700 },
              '& .Mui-selected': { color: '#f8fafc !important' },
            }}
          >
            <Tab value={PROJECT_TAB_CHAT} label="Chat" />
            <Tab value={PROJECT_TAB_TASKS} label="Tasks" />
          </Tabs>

          {activeTab === PROJECT_TAB_CHAT ? (
            <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1.7fr) 360px' } }}>
              <Paper sx={{ p: 0, borderRadius: 4, overflow: 'hidden', backgroundColor: '#0b1322', border: '1px solid rgba(148,163,184,0.12)' }}>
                <Box sx={{ px: 2.5, py: 1.75, borderBottom: '1px solid rgba(148,163,184,0.12)' }}>
                  <Typography variant="h6" sx={{ color: '#f8fafc', fontWeight: 700 }}>
                    Team Chat
                  </Typography>
                  <Typography variant="body2" sx={{ color: '#94a3b8' }}>
                    Discussion stays live here. Project truth stays in the task system and sidebar.
                  </Typography>
                </Box>
                <Box sx={{ px: 2, py: 2, height: { xs: '50vh', lg: '62vh' }, overflowY: 'auto' }}>
                  <Stack spacing={1.5}>
                    {(messages || []).map((message) => {
                      const author = renderMessageAuthor(message);
                      const avatarValue = renderMessageAvatar(message);
                      return (
                        <Paper
                          key={message._id || message.id}
                          sx={{
                            p: 1.5,
                            borderRadius: 3,
                            backgroundColor: message.messageType === 'system' ? 'rgba(248,250,252,0.06)' : 'rgba(15,23,42,0.78)',
                            border: '1px solid rgba(148,163,184,0.08)',
                          }}
                        >
                          <Stack direction="row" spacing={1.25} alignItems="flex-start">
                            <Avatar
                              src={getAvatarSrc(avatarValue) || undefined}
                              sx={{ bgcolor: getAvatarColor(avatarValue || author), width: 34, height: 34 }}
                            >
                              {String(author || '?').charAt(0).toUpperCase()}
                            </Avatar>
                            <Box sx={{ minWidth: 0, flex: 1 }}>
                              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                                <Typography sx={{ color: '#f8fafc', fontWeight: 700 }}>
                                  {author}
                                </Typography>
                                <Typography variant="caption" sx={{ color: '#94a3b8' }}>
                                  {formatDateTime(message.createdAt || message.created_at)}
                                </Typography>
                              </Stack>
                              <Box sx={{ color: '#e2e8f0', mt: 0.5, wordBreak: 'break-word' }}>
                                <MessageContent>{message.content || message.text || ''}</MessageContent>
                              </Box>
                            </Box>
                          </Stack>
                        </Paper>
                      );
                    })}
                    <div ref={messagesEndRef} />
                  </Stack>
                </Box>
                <Box sx={{ p: 2, borderTop: '1px solid rgba(148,163,184,0.12)' }}>
                  <UnifiedComposer
                    members={room?.members || []}
                    agents={podAgents || []}
                    placeholder="Message the team, mention an agent, or log quick context..."
                    onSend={handleSendProjectMessage}
                    showFileUpload={false}
                    showEmoji={false}
                  />
                </Box>
              </Paper>

              <Stack spacing={2}>
                <Paper sx={{ p: 2, borderRadius: 4, backgroundColor: '#111827', border: '1px solid rgba(148,163,184,0.12)' }}>
                  <Typography variant="subtitle2" sx={{ color: '#93c5fd', textTransform: 'uppercase', letterSpacing: 1.1 }}>
                    Brief
                  </Typography>
                  <Typography sx={{ mt: 1, color: '#f8fafc', fontWeight: 700 }}>
                    {room?.projectMeta?.goal || room?.description || 'Add a clear project brief.'}
                  </Typography>
                  <Typography sx={{ mt: 1, color: '#cbd5e1', whiteSpace: 'pre-wrap' }}>
                    {room?.projectMeta?.scope || 'Scope is not defined yet.'}
                  </Typography>
                </Paper>

                <Paper sx={{ p: 2, borderRadius: 4, backgroundColor: '#111827', border: '1px solid rgba(148,163,184,0.12)' }}>
                  <Typography variant="subtitle2" sx={{ color: '#93c5fd', textTransform: 'uppercase', letterSpacing: 1.1 }}>
                    Success Criteria
                  </Typography>
                  <Stack spacing={1} sx={{ mt: 1.25 }}>
                    {(room?.projectMeta?.successCriteria || []).length ? (
                      room.projectMeta.successCriteria.map((criterion, index) => (
                        <Box key={`${criterion}-${index}`} sx={{ color: '#e2e8f0' }}>
                          • {criterion}
                        </Box>
                      ))
                    ) : (
                      <Typography sx={{ color: '#94a3b8' }}>No success criteria captured yet.</Typography>
                    )}
                  </Stack>
                </Paper>

                <Paper sx={{ p: 2, borderRadius: 4, backgroundColor: '#111827', border: '1px solid rgba(148,163,184,0.12)' }}>
                  <Typography variant="subtitle2" sx={{ color: '#93c5fd', textTransform: 'uppercase', letterSpacing: 1.1 }}>
                    Key Information
                  </Typography>
                  <Stack spacing={1.25} sx={{ mt: 1.25 }}>
                    <Typography sx={{ color: '#e2e8f0' }}>Owners: {projectOwners.length ? projectOwners.map((owner) => owner.username).join(', ') : 'Not assigned'}</Typography>
                    <Typography sx={{ color: '#e2e8f0' }}>Due date: {formatShortDate(room?.projectMeta?.dueDate)}</Typography>
                    <Typography sx={{ color: '#e2e8f0' }}>Open blockers: {blockedTaskCount}</Typography>
                    <Typography sx={{ color: '#e2e8f0' }}>Active tasks: {openTaskCount}</Typography>
                  </Stack>
                </Paper>

                <Paper sx={{ p: 2, borderRadius: 4, backgroundColor: '#111827', border: '1px solid rgba(148,163,184,0.12)' }}>
                  <Typography variant="subtitle2" sx={{ color: '#93c5fd', textTransform: 'uppercase', letterSpacing: 1.1 }}>
                    Key Links
                  </Typography>
                  <Stack spacing={1.1} sx={{ mt: 1.25 }}>
                    {(room?.projectMeta?.keyLinks || []).length ? (
                      room.projectMeta.keyLinks.map((link, index) => (
                        <a key={`${link.url}-${index}`} href={link.url} target="_blank" rel="noreferrer" style={{ color: '#f8fafc', textDecoration: 'none' }}>
                          {link.label || link.url}
                        </a>
                      ))
                    ) : (
                      <Typography sx={{ color: '#94a3b8' }}>No linked resources yet.</Typography>
                    )}
                  </Stack>
                </Paper>

                <Paper sx={{ p: 2, borderRadius: 4, backgroundColor: '#111827', border: '1px solid rgba(148,163,184,0.12)' }}>
                  <Typography variant="subtitle2" sx={{ color: '#93c5fd', textTransform: 'uppercase', letterSpacing: 1.1 }}>
                    Members & Agents
                  </Typography>
                  <Stack spacing={1.2} sx={{ mt: 1.25 }}>
                    {(room?.members || []).slice(0, 6).map((member) => (
                      <Stack key={member._id || member.username} direction="row" spacing={1} alignItems="center">
                        <Avatar src={getAvatarSrc(member.profilePicture) || undefined} sx={{ bgcolor: getAvatarColor(member.profilePicture || member.username), width: 28, height: 28 }}>
                          {member.username?.charAt(0)?.toUpperCase()}
                        </Avatar>
                        <Typography sx={{ color: '#e2e8f0' }}>{member.username}</Typography>
                      </Stack>
                    ))}
                    {(podAgents || []).slice(0, 6).map((agent) => (
                      <Stack key={`${agent.name}-${agent.instanceId}`} direction="row" spacing={1} alignItems="center">
                        <Avatar src={agent.profile?.iconUrl || agent.profile?.avatarUrl || agent.iconUrl || undefined} sx={{ width: 28, height: 28 }}>
                          {(agent.displayName || agent.instanceId || agent.name || 'A').charAt(0).toUpperCase()}
                        </Avatar>
                        <Typography sx={{ color: '#e2e8f0' }}>
                          {agent.profile?.displayName || agent.displayName || agent.instanceId || agent.name}
                        </Typography>
                      </Stack>
                    ))}
                  </Stack>
                </Paper>
              </Stack>
            </Box>
          ) : (
            <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', xl: '340px minmax(0, 1fr)' } }}>
              <Paper sx={{ p: 2, borderRadius: 4, backgroundColor: '#0b1322', border: '1px solid rgba(148,163,184,0.12)' }}>
                <Stack spacing={1.5}>
                  <TextField
                    value={taskSearch}
                    onChange={(event) => setTaskSearch(event.target.value)}
                    placeholder="Search tasks..."
                    fullWidth
                    size="small"
                  />
                  <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                    {TASK_FILTERS.map((filterKey) => (
                      <Button
                        key={filterKey}
                        size="small"
                        variant={taskFilter === filterKey ? 'contained' : 'outlined'}
                        onClick={() => setTaskFilter(filterKey)}
                      >
                        {filterKey === 'mine' ? 'My work' : filterKey}
                      </Button>
                    ))}
                  </Stack>
                  <Divider />
                  <Stack spacing={1}>
                    {filteredTasks.length ? filteredTasks.map((task) => (
                      <Paper
                        key={task.taskId}
                        onClick={() => setSelectedTaskId(task.taskId)}
                        sx={{
                          p: 1.4,
                          cursor: 'pointer',
                          borderRadius: 3,
                          backgroundColor: selectedTaskId === task.taskId ? 'rgba(59,130,246,0.16)' : 'rgba(15,23,42,0.88)',
                          border: selectedTaskId === task.taskId ? '1px solid rgba(96,165,250,0.55)' : '1px solid rgba(148,163,184,0.08)',
                        }}
                      >
                        <Stack spacing={0.8}>
                          <Stack direction="row" justifyContent="space-between" spacing={1}>
                            <Typography sx={{ color: '#f8fafc', fontWeight: 700 }}>
                              {task.taskId}
                            </Typography>
                            <Chip size="small" label={taskStatusLabel(task.status)} color={taskStatusColor(task.status)} />
                          </Stack>
                          <Typography sx={{ color: '#e2e8f0', fontWeight: 600 }}>
                            {task.title}
                          </Typography>
                          <Typography variant="body2" sx={{ color: '#94a3b8' }}>
                            {task.assignee ? `Assigned to ${task.assignee}` : 'Unassigned'}
                          </Typography>
                          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                            <Chip size="small" label={`Progress ${task.progressPercent || 0}%`} />
                            {task.priority ? <Chip size="small" label={task.priority} /> : null}
                            {task.dueDate ? <Chip size="small" label={formatShortDate(task.dueDate)} /> : null}
                          </Stack>
                        </Stack>
                      </Paper>
                    )) : (
                      <Typography sx={{ color: '#94a3b8' }}>
                        No tasks match the current filter.
                      </Typography>
                    )}
                  </Stack>
                </Stack>
              </Paper>

              <Paper sx={{ p: 2.5, borderRadius: 4, backgroundColor: '#111827', border: '1px solid rgba(148,163,184,0.12)' }}>
                {selectedTask ? (
                  <Stack spacing={2}>
                    <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" spacing={1.5}>
                      <Box>
                        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                          <Typography variant="h5" sx={{ color: '#f8fafc', fontWeight: 800 }}>
                            {selectedTask.taskId}
                          </Typography>
                          <Chip label={taskStatusLabel(selectedTask.status)} color={taskStatusColor(selectedTask.status)} />
                          {selectedTask.priority ? <Chip label={selectedTask.priority} /> : null}
                        </Stack>
                        <Typography variant="h4" sx={{ mt: 1, color: '#f8fafc', fontSize: { xs: '1.5rem', md: '2rem' }, fontWeight: 800 }}>
                          {selectedTask.title}
                        </Typography>
                      </Box>
                      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                        <Tooltip title="Take task">
                          <span>
                            <IconButton color="primary" onClick={handleTakeTask} disabled={saving}>
                              <TakeTaskIcon />
                            </IconButton>
                          </span>
                        </Tooltip>
                        <Tooltip title="Assign task">
                          <span>
                            <IconButton color="primary" onClick={() => { setAssignKey(''); setAssignOpen(true); }} disabled={saving}>
                              <TaskIcon />
                            </IconButton>
                          </span>
                        </Tooltip>
                        <Tooltip title="Post progress">
                          <span>
                            <IconButton color="primary" onClick={() => setProgressOpen(true)} disabled={saving}>
                              <EditIcon />
                            </IconButton>
                          </span>
                        </Tooltip>
                        <Tooltip title="Raise blocker">
                          <span>
                            <IconButton color="warning" onClick={() => setBlockerOpen(true)} disabled={saving}>
                              <FlagIcon />
                            </IconButton>
                          </span>
                        </Tooltip>
                        <Tooltip title="Complete task">
                          <span>
                            <IconButton color="success" onClick={() => setCompleteOpen(true)} disabled={saving}>
                              <CompleteIcon />
                            </IconButton>
                          </span>
                        </Tooltip>
                      </Stack>
                    </Stack>

                    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                      <Chip label={`Assignee: ${selectedTask.assignee || 'Unassigned'}`} />
                      <Chip label={`Progress: ${selectedTask.progressPercent || 0}%`} />
                      <Chip label={`Due: ${formatShortDate(selectedTask.dueDate)}`} />
                      {selectedTask.dep ? <Chip label={`Depends on ${selectedTask.dep}`} /> : null}
                    </Stack>

                    <Paper sx={{ p: 2, borderRadius: 3, backgroundColor: 'rgba(15,23,42,0.85)' }}>
                      <Typography variant="subtitle2" sx={{ color: '#93c5fd', textTransform: 'uppercase', letterSpacing: 1.1 }}>
                        Description
                      </Typography>
                      <Typography sx={{ mt: 1, color: '#e2e8f0', whiteSpace: 'pre-wrap' }}>
                        {selectedTask.description || selectedTask.notes || 'No detailed task brief yet.'}
                      </Typography>
                    </Paper>

                    <Paper sx={{ p: 2, borderRadius: 3, backgroundColor: 'rgba(15,23,42,0.85)' }}>
                      <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                        <Typography variant="subtitle2" sx={{ color: '#93c5fd', textTransform: 'uppercase', letterSpacing: 1.1 }}>
                          Blocker
                        </Typography>
                        {selectedTask.blocker?.open ? (
                          <Button color="warning" size="small" onClick={handleClearBlocker} disabled={saving}>
                            Clear blocker
                          </Button>
                        ) : null}
                      </Stack>
                      {selectedTask.blocker?.open ? (
                        <Stack spacing={0.7} sx={{ mt: 1 }}>
                          <Typography sx={{ color: '#f8fafc', fontWeight: 700 }}>{selectedTask.blocker.reason}</Typography>
                          <Typography sx={{ color: '#cbd5e1' }}>Waiting on: {selectedTask.blocker.waitingOn || 'Not specified'}</Typography>
                          <Typography sx={{ color: '#cbd5e1' }}>Severity: {selectedTask.blocker.severity || 'medium'}</Typography>
                          <Typography sx={{ color: '#94a3b8' }}>Opened {formatDateTime(selectedTask.blocker.openedAt)}</Typography>
                        </Stack>
                      ) : (
                        <Typography sx={{ mt: 1, color: '#94a3b8' }}>
                          No active blocker.
                        </Typography>
                      )}
                    </Paper>

                    <Paper sx={{ p: 2, borderRadius: 3, backgroundColor: 'rgba(15,23,42,0.85)' }}>
                      <Typography variant="subtitle2" sx={{ color: '#93c5fd', textTransform: 'uppercase', letterSpacing: 1.1 }}>
                        Updates
                      </Typography>
                      <Stack spacing={1.2} sx={{ mt: 1.25 }}>
                        {(selectedTask.updates || []).length ? selectedTask.updates.slice().reverse().map((update, index) => (
                          <Box key={`${update.createdAt}-${index}`} sx={{ pb: 1.2, borderBottom: index === (selectedTask.updates.length - 1) ? 'none' : '1px solid rgba(148,163,184,0.12)' }}>
                            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                              <Typography sx={{ color: '#f8fafc', fontWeight: 700 }}>
                                {update.author || 'system'}
                              </Typography>
                              {update.kind ? <Chip size="small" label={update.kind} /> : null}
                              <Typography variant="caption" sx={{ color: '#94a3b8' }}>
                                {formatDateTime(update.createdAt)}
                              </Typography>
                            </Stack>
                            <Typography sx={{ mt: 0.5, color: '#e2e8f0', whiteSpace: 'pre-wrap' }}>
                              {update.text}
                            </Typography>
                            {update.progressPercent !== undefined && update.progressPercent !== null ? (
                              <Typography variant="body2" sx={{ mt: 0.4, color: '#cbd5e1' }}>
                                Progress: {update.progressPercent}%
                              </Typography>
                            ) : null}
                            {update.nextStep ? (
                              <Typography variant="body2" sx={{ mt: 0.4, color: '#cbd5e1' }}>
                                Next step: {update.nextStep}
                              </Typography>
                            ) : null}
                          </Box>
                        )) : (
                          <Typography sx={{ color: '#94a3b8' }}>No task updates yet.</Typography>
                        )}
                      </Stack>
                    </Paper>
                  </Stack>
                ) : (
                  <Typography sx={{ color: '#94a3b8' }}>
                    Select a task to inspect its full details.
                  </Typography>
                )}
              </Paper>
            </Box>
          )}
        </Stack>
      </Paper>

      <Dialog open={projectDialogOpen} onClose={() => setProjectDialogOpen(false)} fullWidth maxWidth="md">
        <DialogTitle>Edit Project</DialogTitle>
        <DialogContent sx={{ display: 'grid', gap: 1.5, pt: '10px !important' }}>
          <TextField label="Project name" value={projectForm.name} onChange={(event) => setProjectForm((prev) => ({ ...prev, name: event.target.value }))} fullWidth />
          <TextField label="Description" value={projectForm.description} onChange={(event) => setProjectForm((prev) => ({ ...prev, description: event.target.value }))} fullWidth multiline minRows={2} />
          <TextField label="Goal" value={projectForm.goal} onChange={(event) => setProjectForm((prev) => ({ ...prev, goal: event.target.value }))} fullWidth multiline minRows={2} />
          <TextField label="Scope" value={projectForm.scope} onChange={(event) => setProjectForm((prev) => ({ ...prev, scope: event.target.value }))} fullWidth multiline minRows={3} />
          <TextField label="Success criteria (one per line)" value={projectForm.successCriteriaText} onChange={(event) => setProjectForm((prev) => ({ ...prev, successCriteriaText: event.target.value }))} fullWidth multiline minRows={3} />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField select label="Status" value={projectForm.status} onChange={(event) => setProjectForm((prev) => ({ ...prev, status: event.target.value }))} fullWidth>
              <MenuItem value="planning">Planning</MenuItem>
              <MenuItem value="on-track">On track</MenuItem>
              <MenuItem value="at-risk">At risk</MenuItem>
              <MenuItem value="blocked">Blocked</MenuItem>
              <MenuItem value="complete">Complete</MenuItem>
            </TextField>
            <TextField label="Due date" type="date" value={projectForm.dueDate} onChange={(event) => setProjectForm((prev) => ({ ...prev, dueDate: event.target.value }))} fullWidth InputLabelProps={{ shrink: true }} />
          </Stack>
          <TextField label="Key links (Label | URL per line)" value={projectForm.keyLinksText} onChange={(event) => setProjectForm((prev) => ({ ...prev, keyLinksText: event.target.value }))} fullWidth multiline minRows={3} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setProjectDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleSaveProject} variant="contained" disabled={saving}>Save</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={newTaskOpen} onClose={() => setNewTaskOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>New Task</DialogTitle>
        <DialogContent sx={{ display: 'grid', gap: 1.5, pt: '10px !important' }}>
          <TextField label="Title" value={newTaskForm.title} onChange={(event) => setNewTaskForm((prev) => ({ ...prev, title: event.target.value }))} fullWidth />
          <TextField label="Description" value={newTaskForm.description} onChange={(event) => setNewTaskForm((prev) => ({ ...prev, description: event.target.value }))} fullWidth multiline minRows={3} />
          <TextField select label="Assign to" value={newTaskForm.assigneeKey} onChange={(event) => setNewTaskForm((prev) => ({ ...prev, assigneeKey: event.target.value }))} fullWidth>
            <MenuItem value="">Unassigned</MenuItem>
            {assignmentOptions.map((option) => (
              <MenuItem key={option.key} value={option.key}>{option.label}</MenuItem>
            ))}
          </TextField>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField select label="Priority" value={newTaskForm.priority} onChange={(event) => setNewTaskForm((prev) => ({ ...prev, priority: event.target.value }))} fullWidth>
              <MenuItem value="low">Low</MenuItem>
              <MenuItem value="medium">Medium</MenuItem>
              <MenuItem value="high">High</MenuItem>
            </TextField>
            <TextField label="Due date" type="date" value={newTaskForm.dueDate} onChange={(event) => setNewTaskForm((prev) => ({ ...prev, dueDate: event.target.value }))} fullWidth InputLabelProps={{ shrink: true }} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNewTaskOpen(false)}>Cancel</Button>
          <Button onClick={handleCreateTask} variant="contained" disabled={saving}>Create task</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={assignOpen} onClose={() => setAssignOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Assign Task</DialogTitle>
        <DialogContent sx={{ pt: '10px !important' }}>
          <TextField select label="Assignee" value={assignKey} onChange={(event) => setAssignKey(event.target.value)} fullWidth>
            {assignmentOptions.map((option) => (
              <MenuItem key={option.key} value={option.key}>{option.label}</MenuItem>
            ))}
          </TextField>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAssignOpen(false)}>Cancel</Button>
          <Button onClick={handleAssignTask} variant="contained" disabled={saving || !assignKey}>Save</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={progressOpen} onClose={() => setProgressOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Post Progress</DialogTitle>
        <DialogContent sx={{ display: 'grid', gap: 1.5, pt: '10px !important' }}>
          <TextField label="Update" value={progressForm.text} onChange={(event) => setProgressForm((prev) => ({ ...prev, text: event.target.value }))} fullWidth multiline minRows={3} />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField label="Progress %" type="number" value={progressForm.progressPercent} onChange={(event) => setProgressForm((prev) => ({ ...prev, progressPercent: event.target.value }))} fullWidth inputProps={{ min: 0, max: 100 }} />
            <TextField label="Next step" value={progressForm.nextStep} onChange={(event) => setProgressForm((prev) => ({ ...prev, nextStep: event.target.value }))} fullWidth />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setProgressOpen(false)}>Cancel</Button>
          <Button onClick={handlePostProgress} variant="contained" disabled={saving}>Post update</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={blockerOpen} onClose={() => setBlockerOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Raise Blocker</DialogTitle>
        <DialogContent sx={{ display: 'grid', gap: 1.5, pt: '10px !important' }}>
          <TextField label="Reason" value={blockerForm.reason} onChange={(event) => setBlockerForm((prev) => ({ ...prev, reason: event.target.value }))} fullWidth multiline minRows={3} />
          <TextField label="Waiting on" value={blockerForm.waitingOn} onChange={(event) => setBlockerForm((prev) => ({ ...prev, waitingOn: event.target.value }))} fullWidth />
          <TextField select label="Severity" value={blockerForm.severity} onChange={(event) => setBlockerForm((prev) => ({ ...prev, severity: event.target.value }))} fullWidth>
            <MenuItem value="low">Low</MenuItem>
            <MenuItem value="medium">Medium</MenuItem>
            <MenuItem value="high">High</MenuItem>
          </TextField>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setBlockerOpen(false)}>Cancel</Button>
          <Button onClick={handleSaveBlocker} color="warning" variant="contained" disabled={saving}>Raise blocker</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={completeOpen} onClose={() => setCompleteOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Complete Task</DialogTitle>
        <DialogContent sx={{ pt: '10px !important' }}>
          <TextField label="Completion notes" value={completeNotes} onChange={(event) => setCompleteNotes(event.target.value)} fullWidth multiline minRows={3} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCompleteOpen(false)}>Cancel</Button>
          <Button onClick={handleCompleteTask} color="success" variant="contained" disabled={saving}>Complete</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default ProjectPodRoom;
