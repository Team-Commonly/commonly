import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './ApiDevPage.css';
import {
    Box,
    Button,
    TextField,
    MenuItem,
    Typography,
    Accordion,
    AccordionSummary,
    AccordionDetails,
    Chip,
    Paper,
    Grid,
    Divider,
    Alert,
    CircularProgress,
    Stack,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';

const ApiDevPage = () => {
    const [responses, setResponses] = useState({});
    const [loading, setLoading] = useState({});
    const [customInputs, setCustomInputs] = useState({});
    const [llmStatus, setLlmStatus] = useState(null);
    const [llmStatusLoading, setLlmStatusLoading] = useState(false);
    const [llmStatusError, setLlmStatusError] = useState(null);
    const [devEventPodId, setDevEventPodId] = useState('');
    const [devEventPods, setDevEventPods] = useState([]);
    const [devEventPodsLoading, setDevEventPodsLoading] = useState(false);
    const [devEventAgentName, setDevEventAgentName] = useState('clawdbot-bridge');
    const [devEventType, setDevEventType] = useState('integration.summary');
    const [devEventSummary, setDevEventSummary] = useState('Discord: Team discussed rollout plan and next steps.');
    const [devEventLoading, setDevEventLoading] = useState(false);
    const [devEventError, setDevEventError] = useState(null);
    const [devEventSuccess, setDevEventSuccess] = useState(null);
    const [token] = useState(localStorage.getItem('token'));

    const apiEndpoints = [
        {
            category: "Authentication",
            endpoints: [
                {
                    id: "auth-register",
                    method: "POST",
                    path: "/api/auth/register",
                    description: "Register a new user",
                    requiresAuth: false,
                    exampleInput: {
                        username: "testuser",
                        email: "test@example.com",
                        password: "password123"
                    },
                    exampleOutput: {
                        message: "User registered successfully. Check your email for verification."
                    }
                },
                {
                    id: "auth-login",
                    method: "POST",
                    path: "/api/auth/login",
                    description: "Login user",
                    requiresAuth: false,
                    exampleInput: {
                        email: "test@example.com",
                        password: "password123"
                    },
                    exampleOutput: {
                        token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
                        verified: true,
                        user: {
                            id: "60d5ecb74b24a1234567890a",
                            username: "testuser",
                            email: "test@example.com",
                            profilePicture: "default"
                        }
                    }
                },
                {
                    id: "auth-profile",
                    method: "GET",
                    path: "/api/auth/profile",
                    description: "Get current user profile",
                    requiresAuth: true,
                    exampleInput: null,
                    exampleOutput: {
                        _id: "60d5ecb74b24a1234567890a",
                        username: "testuser",
                        email: "test@example.com",
                        profilePicture: "default",
                        verified: true,
                        createdAt: "2023-01-01T00:00:00.000Z"
                    }
                },
                {
                    id: "auth-update-profile",
                    method: "PUT",
                    path: "/api/auth/profile",
                    description: "Update user profile",
                    requiresAuth: true,
                    exampleInput: {
                        profilePicture: "blue"
                    },
                    exampleOutput: {
                        _id: "60d5ecb74b24a1234567890a",
                        username: "testuser",
                        email: "test@example.com",
                        profilePicture: "blue",
                        verified: true,
                        createdAt: "2023-01-01T00:00:00.000Z"
                    }
                }
            ]
        },
        {
            category: "Posts",
            endpoints: [
                {
                    id: "posts-get-all",
                    method: "GET",
                    path: "/api/posts",
                    description: "Get all posts",
                    requiresAuth: false,
                    exampleInput: null,
                    exampleOutput: [
                        {
                            _id: "60d5ecb74b24a1234567890b",
                            content: "This is a sample post",
                            userId: {
                                _id: "60d5ecb74b24a1234567890a",
                                username: "testuser",
                                profilePicture: "default"
                            },
                            likes: 5,
                            comments: [],
                            tags: ["sample", "test"],
                            createdAt: "2023-01-01T00:00:00.000Z"
                        }
                    ]
                },
                {
                    id: "posts-create",
                    method: "POST",
                    path: "/api/posts",
                    description: "Create a new post",
                    requiresAuth: true,
                    exampleInput: {
                        content: "This is my new post!",
                        tags: ["new", "post"],
                        image: "https://example.com/image.jpg"
                    },
                    exampleOutput: {
                        _id: "60d5ecb74b24a1234567890c",
                        content: "This is my new post!",
                        userId: "60d5ecb74b24a1234567890a",
                        likes: 0,
                        comments: [],
                        tags: ["new", "post"],
                        image: "https://example.com/image.jpg",
                        createdAt: "2023-01-01T00:00:00.000Z"
                    }
                },
                {
                    id: "posts-get-by-id",
                    method: "GET",
                    path: "/api/posts/:id",
                    description: "Get a specific post by ID",
                    requiresAuth: false,
                    exampleInput: null,
                    pathParams: { id: "60d5ecb74b24a1234567890b" },
                    exampleOutput: {
                        _id: "60d5ecb74b24a1234567890b",
                        content: "This is a sample post",
                        userId: {
                            _id: "60d5ecb74b24a1234567890a",
                            username: "testuser",
                            profilePicture: "default"
                        },
                        likes: 5,
                        comments: [],
                        tags: ["sample", "test"],
                        createdAt: "2023-01-01T00:00:00.000Z"
                    }
                },
                {
                    id: "posts-search",
                    method: "GET",
                    path: "/api/posts/search",
                    description: "Search posts by content or tags",
                    requiresAuth: false,
                    exampleInput: null,
                    queryParams: { query: "sample", tags: "test,sample" },
                    exampleOutput: [
                        {
                            _id: "60d5ecb74b24a1234567890b",
                            content: "This is a sample post",
                            userId: {
                                _id: "60d5ecb74b24a1234567890a",
                                username: "testuser",
                                profilePicture: "default"
                            },
                            likes: 5,
                            comments: [],
                            tags: ["sample", "test"],
                            createdAt: "2023-01-01T00:00:00.000Z"
                        }
                    ]
                },
                {
                    id: "posts-add-comment",
                    method: "POST",
                    path: "/api/posts/:id/comments",
                    description: "Add a comment to a post",
                    requiresAuth: true,
                    exampleInput: {
                        text: "Great post!"
                    },
                    pathParams: { id: "60d5ecb74b24a1234567890b" },
                    exampleOutput: {
                        _id: "60d5ecb74b24a1234567890d",
                        userId: {
                            _id: "60d5ecb74b24a1234567890a",
                            username: "testuser",
                            profilePicture: "default"
                        },
                        text: "Great post!",
                        createdAt: "2023-01-01T00:00:00.000Z"
                    }
                },
                {
                    id: "posts-like",
                    method: "POST",
                    path: "/api/posts/:id/like",
                    description: "Like/unlike a post",
                    requiresAuth: true,
                    exampleInput: null,
                    pathParams: { id: "60d5ecb74b24a1234567890b" },
                    exampleOutput: {
                        likes: 6,
                        liked: true
                    }
                },
                {
                    id: "posts-delete",
                    method: "DELETE",
                    path: "/api/posts/:id",
                    description: "Delete a post",
                    requiresAuth: true,
                    exampleInput: null,
                    pathParams: { id: "60d5ecb74b24a1234567890b" },
                    exampleOutput: {
                        message: "Post deleted successfully"
                    }
                }
            ]
        },
        {
            category: "File Uploads",
            endpoints: [
                {
                    id: "uploads-post",
                    method: "POST",
                    path: "/api/uploads",
                    description: "Upload an image file",
                    requiresAuth: true,
                    exampleInput: "FormData with 'image' field",
                    exampleOutput: {
                        url: "http://localhost:5000/api/uploads/1640995200000-123456789.jpg",
                        fileName: "1640995200000-123456789.jpg",
                        contentType: "image/jpeg",
                        size: 1024000
                    }
                },
                {
                    id: "uploads-get",
                    method: "GET",
                    path: "/api/uploads/:fileName",
                    description: "Get an uploaded image",
                    requiresAuth: false,
                    exampleInput: null,
                    pathParams: { fileName: "1640995200000-123456789.jpg" },
                    exampleOutput: "Binary image data"
                }
            ]
        },
        {
            category: "Integrations",
            endpoints: [
                {
                    id: "integrations-catalog",
                    method: "GET",
                    path: "/api/integrations/catalog",
                    description: "Get manifest-driven integration catalog entries",
                    requiresAuth: true,
                    exampleInput: null,
                    exampleOutput: {
                        entries: [
                            {
                                id: "slack",
                                requiredConfig: ["botToken", "signingSecret", "channelId"],
                                catalog: {
                                    label: "Slack",
                                    category: "chat",
                                    capabilities: ["webhook", "summary"]
                                },
                                stats: {
                                    activeIntegrations: 2
                                }
                            }
                        ]
                    }
                }
            ]
        },
        {
            category: "Context API",
            endpoints: [
                {
                    id: "context-index-stats",
                    method: "GET",
                    path: "/api/v1/pods/:podId/index/stats",
                    description: "Get vector index stats for a pod",
                    requiresAuth: true,
                    exampleInput: null,
                    pathParams: { podId: "60d5ecb74b24a1234567890b" },
                    exampleOutput: {
                        podId: "60d5ecb74b24a1234567890b",
                        stats: {
                            available: true,
                            chunks: 120,
                            assets: 12,
                            embeddings: 120
                        }
                    }
                },
                {
                    id: "context-rebuild-index",
                    method: "POST",
                    path: "/api/v1/pods/:podId/index/rebuild",
                    description: "Rebuild vector index for a pod (admin only)",
                    requiresAuth: true,
                    exampleInput: {
                        reset: true
                    },
                    pathParams: { podId: "60d5ecb74b24a1234567890b" },
                    exampleOutput: {
                        podId: "60d5ecb74b24a1234567890b",
                        reset: true,
                        indexed: 12,
                        errors: 0,
                        total: 12
                    }
                },
                {
                    id: "context-rebuild-index-all",
                    method: "POST",
                    path: "/api/v1/index/rebuild-all",
                    description: "Rebuild vector indices for all pods you own",
                    requiresAuth: true,
                    exampleInput: {
                        reset: true
                    },
                    exampleOutput: {
                        pods: 3,
                        indexed: 120,
                        errors: 0,
                        total: 120,
                        reset: true
                    }
                }
            ]
        },
        {
            category: "Documentation",
            endpoints: [
                {
                    id: "docs-backend",
                    method: "GET",
                    path: "/api/docs/backend",
                    description: "Get backend API documentation",
                    requiresAuth: false,
                    exampleInput: null,
                    exampleOutput: "# Backend Documentation\n\nThis document provides details about the backend architecture..."
                }
            ]
        },
        {
            category: "Dev Tools",
            endpoints: [
                {
                    id: "dev-llm-status",
                    method: "GET",
                    path: "/api/dev/llm/status",
                    description: "Get LLM gateway status (LiteLLM + Gemini)",
                    requiresAuth: true,
                    exampleInput: null,
                    exampleOutput: {
                        litellm: {
                            enabled: true,
                            baseUrl: "http://litellm:4000",
                            model: "gemini-2.5-flash",
                            embeddingProvider: "litellm",
                            embeddingModel: "text-embedding-3-large",
                            embeddingDimensions: 3072,
                            ok: true,
                            models: [
                                { id: "gpt-4o" },
                                { id: "gemini-2.5-flash" }
                            ]
                        },
                        gemini: {
                            enabled: true
                        }
                    }
                },
                {
                    id: "dev-agent-event",
                    method: "POST",
                    path: "/api/dev/agents/events",
                    description: "Enqueue a dev agent event (for bridge testing)",
                    requiresAuth: true,
                    exampleInput: {
                        podId: "60d5ecb74b24a1234567890b",
                        agentName: "clawdbot-bridge",
                        type: "integration.summary",
                        payload: {
                            summary: {
                                content: "Discord: Team discussed rollout plan and next steps."
                            }
                        }
                    },
                    exampleOutput: {
                        success: true,
                        eventId: "65f0e1f23b1234567890abcd"
                    }
                }
            ]
        }
    ];

    // Initialize custom inputs with example data
    const initializeCustomInput = (endpoint) => {
        const key = endpoint.id;
        if (!customInputs[key]) {
            setCustomInputs(prev => ({
                ...prev,
                [key]: {
                    body: endpoint.exampleInput ? JSON.stringify(endpoint.exampleInput, null, 2) : '',
                    pathParams: endpoint.pathParams ? JSON.stringify(endpoint.pathParams, null, 2) : '',
                    queryParams: endpoint.queryParams ? JSON.stringify(endpoint.queryParams, null, 2) : ''
                }
            }));
        }
    };

    const handleTestEndpoint = async (endpoint) => {
        const endpointId = endpoint.id;
        setLoading(prev => ({ ...prev, [endpointId]: true }));

        try {
            let url = endpoint.path;
            
            // Get custom inputs or fall back to examples
            const customInput = customInputs[endpointId];
            
            // Replace path parameters
            if (endpoint.pathParams || (customInput && customInput.pathParams)) {
                let pathParams = endpoint.pathParams;
                if (customInput && customInput.pathParams) {
                    try {
                        pathParams = JSON.parse(customInput.pathParams);
                    } catch (e) {
                        pathParams = endpoint.pathParams;
                    }
                }
                if (pathParams) {
                    Object.entries(pathParams).forEach(([key, value]) => {
                        url = url.replace(`:${key}`, value);
                    });
                }
            }

            // Add query parameters
            if (endpoint.queryParams || (customInput && customInput.queryParams)) {
                let queryParams = endpoint.queryParams;
                if (customInput && customInput.queryParams) {
                    try {
                        queryParams = JSON.parse(customInput.queryParams);
                    } catch (e) {
                        queryParams = endpoint.queryParams;
                    }
                }
                if (queryParams) {
                    const params = new URLSearchParams(queryParams);
                    url += `?${params.toString()}`;
                }
            }

            const options = {
                method: endpoint.method,
                url,
                headers: {} as Record<string, string>
            } as Record<string, any>;

            // Add authorization header if required
            if (endpoint.requiresAuth && token) {
                options.headers.Authorization = `Bearer ${token}`;
            }

            // Add request body for POST/PUT requests
            if (endpoint.method === 'POST' || endpoint.method === 'PUT') {
                let requestBody = endpoint.exampleInput;
                if (customInput && customInput.body) {
                    try {
                        requestBody = JSON.parse(customInput.body);
                    } catch (e) {
                        requestBody = endpoint.exampleInput;
                    }
                }
                if (requestBody && typeof requestBody !== 'string') {
                    options.data = requestBody;
                    options.headers['Content-Type'] = 'application/json';
                }
            }

            const response = await axios(options);
            setResponses(prev => ({
                ...prev,
                [endpointId]: {
                    status: response.status,
                    data: response.data,
                    error: null
                }
            }));
        } catch (error) {
            setResponses(prev => ({
                ...prev,
                [endpointId]: {
                    status: error.response?.status || 'Error',
                    data: error.response?.data || error.message,
                    error: true
                }
            }));
        } finally {
            setLoading(prev => ({ ...prev, [endpointId]: false }));
        }
    };

    const handleInputChange = (endpointId, field, value) => {
        setCustomInputs(prev => ({
            ...prev,
            [endpointId]: {
                ...prev[endpointId],
                [field]: value
            }
        }));
    };

    const getMethodColor = (method) => {
        switch (method) {
            case 'GET': return 'success';
            case 'POST': return 'primary';
            case 'PUT': return 'warning';
            case 'DELETE': return 'error';
            default: return 'default';
        }
    };

    const handleFetchLlmStatus = async () => {
        if (!token) return;
        try {
            setLlmStatusLoading(true);
            const res = await axios.get('/api/dev/llm/status', {
                headers: { Authorization: `Bearer ${token}` }
            });
            setLlmStatus(res.data);
            setLlmStatusError(null);
        } catch (error) {
            setLlmStatusError(error.response?.data?.error || error.message);
        } finally {
            setLlmStatusLoading(false);
        }
    };

    const handleSendDevEvent = async () => {
        if (!token || !devEventPodId || !devEventAgentName || !devEventType) return;
        try {
            setDevEventLoading(true);
            setDevEventError(null);
            setDevEventSuccess(null);
            const res = await axios.post('/api/dev/agents/events', {
                podId: devEventPodId,
                agentName: devEventAgentName,
                type: devEventType,
                payload: {
                    summary: {
                        content: devEventSummary || ''
                    }
                }
            }, {
                headers: { Authorization: `Bearer ${token}` }
            });
            setDevEventSuccess(res.data);
        } catch (error) {
            setDevEventError(error.response?.data?.error || error.message);
        } finally {
            setDevEventLoading(false);
        }
    };

    const handleLoadPods = async () => {
        if (!token) return;
        try {
            setDevEventPodsLoading(true);
            const res = await axios.get('/api/pods', {
                headers: { Authorization: `Bearer ${token}` }
            });
            setDevEventPods(res.data || []);
            if (!devEventPodId && res.data?.length) {
                setDevEventPodId(res.data[0]._id);
            }
        } catch (error) {
            setDevEventError(error.response?.data?.error || error.message);
        } finally {
            setDevEventPodsLoading(false);
        }
    };

    useEffect(() => {
        if (token && devEventPods.length === 0) {
            handleLoadPods();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token]);

    return (
        <Box className="api-dev-root">
            <Box className="api-dev-container">
                <Box className="api-dev-hero">
                    <Box className="api-dev-hero-text">
                        <Typography variant="overline" className="api-dev-eyebrow">
                            Developer Utilities
                        </Typography>
                        <Typography variant="h3" className="api-dev-title">
                            API Dev Console
                        </Typography>
                        <Typography variant="body1" className="api-dev-subtitle">
                            Exercise REST endpoints, inspect LLM routing, and queue agent events without leaving the app.
                        </Typography>
                    </Box>
                    <Box className="api-dev-hero-meta">
                        <Chip size="small" label="LLM Gateway" />
                        <Chip size="small" label="Agent Queue" />
                        <Chip size="small" label="REST Playground" />
                    </Box>
                </Box>

                <Divider className="api-dev-divider" />

                {!token && (
                    <Alert severity="warning" sx={{ mb: 3 }}>
                        You are not logged in. Some endpoints that require authentication will fail.
                    </Alert>
                )}

                <Grid container spacing={3} className="api-dev-top-grid">
                    <Grid item xs={12} md={6}>
                        <Paper className="api-dev-panel" sx={{ p: 3 }}>
                            <Stack spacing={2}>
                                <Stack direction="row" spacing={1} alignItems="center">
                                    <Typography variant="h6" className="api-dev-panel-title">LLM Gateway Status</Typography>
                                    <Chip size="small" label="Dev" color="warning" className="api-dev-status-chip" />
                                </Stack>
                                <Typography variant="body2" color="text.secondary">
                                    Check LiteLLM + Gemini availability and the configured embedding provider.
                                </Typography>
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                                    <Button
                                        variant="contained"
                                        startIcon={llmStatusLoading ? <CircularProgress size={16} /> : <PlayArrowIcon />}
                                        onClick={handleFetchLlmStatus}
                                        disabled={!token || llmStatusLoading}
                                    >
                                        {llmStatusLoading ? 'Checking...' : 'Fetch Status'}
                                    </Button>
                                    {!token && (
                                        <Typography variant="caption" color="text.secondary">
                                            Login required to call /api/dev/llm/status
                                        </Typography>
                                    )}
                                </Box>
                                {llmStatusError && (
                                    <Alert severity="error">{llmStatusError}</Alert>
                                )}
                                {llmStatus && (
                                    <Stack spacing={1}>
                                        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                                            <Chip
                                                label={`LiteLLM: ${llmStatus.litellm?.enabled ? 'enabled' : 'disabled'}`}
                                                color={llmStatus.litellm?.enabled ? 'success' : 'default'}
                                                size="small"
                                            />
                                            <Chip
                                                label={`Gemini: ${llmStatus.gemini?.enabled ? 'enabled' : 'disabled'}`}
                                                color={llmStatus.gemini?.enabled ? 'success' : 'default'}
                                                size="small"
                                            />
                                            {llmStatus.litellm?.ok !== null && (
                                                <Chip
                                                    label={`LiteLLM ok: ${llmStatus.litellm?.ok ? 'yes' : 'no'}`}
                                                    color={llmStatus.litellm?.ok ? 'success' : 'warning'}
                                                    size="small"
                                                />
                                            )}
                                        </Stack>
                                        {llmStatus.litellm?.baseUrl && (
                                            <Typography variant="body2" color="text.secondary">
                                                Base URL: {llmStatus.litellm.baseUrl}
                                            </Typography>
                                        )}
                                        <Typography variant="body2" color="text.secondary">
                                            Embedding: {llmStatus.litellm?.embeddingProvider} / {llmStatus.litellm?.embeddingModel} ({llmStatus.litellm?.embeddingDimensions})
                                        </Typography>
                                        {Array.isArray(llmStatus.litellm?.models) && llmStatus.litellm.models.length > 0 && (
                                            <Paper sx={{ p: 2, bgcolor: 'grey.50' }}>
                                                <Typography variant="subtitle2" sx={{ mb: 1 }}>
                                                    Available Models
                                                </Typography>
                                                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                                                    {llmStatus.litellm.models.map((model) => (
                                                        <Chip
                                                            key={model.id || model.model_name || JSON.stringify(model)}
                                                            label={model.id || model.model_name || 'model'}
                                                            size="small"
                                                        />
                                                    ))}
                                                </Stack>
                                            </Paper>
                                        )}
                                    </Stack>
                                )}
                            </Stack>
                        </Paper>
                    </Grid>
                    <Grid item xs={12} md={6}>
                        <Paper className="api-dev-panel" sx={{ p: 3 }}>
                            <Stack spacing={2}>
                                <Stack direction="row" spacing={1} alignItems="center">
                                    <Typography variant="h6" className="api-dev-panel-title">Agent Event Debug</Typography>
                                    <Chip size="small" label="Dev" color="warning" className="api-dev-status-chip" />
                                </Stack>
                                <Typography variant="body2" color="text.secondary">
                                    Enqueue a test agent event to exercise bridges like Clawdbot.
                                </Typography>
                                <Grid container spacing={2}>
                                    <Grid item xs={12} md={4}>
                                        <TextField
                                            fullWidth
                                            select
                                            label="Pod"
                                            value={devEventPodId}
                                            onChange={(e) => setDevEventPodId(e.target.value)}
                                            helperText={devEventPods.length ? 'Select a pod' : 'Load pods to choose'}
                                        >
                                            {devEventPods.length > 0 ? (
                                                devEventPods.map((pod) => (
                                                    <MenuItem key={pod._id} value={pod._id}>
                                                        {pod.name}
                                                    </MenuItem>
                                                ))
                                            ) : (
                                                <MenuItem value="" disabled>
                                                    No pods loaded
                                                </MenuItem>
                                            )}
                                        </TextField>
                                        {devEventPods.length === 0 && (
                                            <Button
                                                size="small"
                                                sx={{ mt: 1 }}
                                                variant="text"
                                                onClick={handleLoadPods}
                                                disabled={devEventPodsLoading || !token}
                                            >
                                                {devEventPodsLoading ? 'Loading...' : 'Load Pods'}
                                            </Button>
                                        )}
                                    </Grid>
                                    <Grid item xs={12} md={4}>
                                        <TextField
                                            fullWidth
                                            label="Agent Name"
                                            value={devEventAgentName}
                                            onChange={(e) => setDevEventAgentName(e.target.value)}
                                            placeholder="clawdbot-bridge"
                                        />
                                    </Grid>
                                    <Grid item xs={12} md={4}>
                                        <TextField
                                            fullWidth
                                            label="Event Type"
                                            value={devEventType}
                                            onChange={(e) => setDevEventType(e.target.value)}
                                            placeholder="integration.summary"
                                        />
                                    </Grid>
                                    <Grid item xs={12}>
                                        <TextField
                                            fullWidth
                                            label="Summary Content"
                                            value={devEventSummary}
                                            onChange={(e) => setDevEventSummary(e.target.value)}
                                            multiline
                                            minRows={3}
                                        />
                                    </Grid>
                                </Grid>
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                                    <Button
                                        variant="contained"
                                        onClick={handleSendDevEvent}
                                        startIcon={devEventLoading ? <CircularProgress size={16} /> : <PlayArrowIcon />}
                                        disabled={!token || devEventLoading || !devEventPodId}
                                    >
                                        {devEventLoading ? 'Enqueuing...' : 'Enqueue Event'}
                                    </Button>
                                </Box>
                                {devEventError && <Alert severity="error">{devEventError}</Alert>}
                                {devEventSuccess && (
                                    <Alert severity="success">
                                        Event queued: {devEventSuccess.eventId}
                                    </Alert>
                                )}
                            </Stack>
                        </Paper>
                    </Grid>
                </Grid>

            {apiEndpoints.map((category) => (
                <Box key={category.category} sx={{ mb: 4 }} className="api-dev-category">
                    <Typography variant="h5" className="api-dev-section-title">
                        {category.category}
                    </Typography>
                    
                    {category.endpoints.map((endpoint) => {
                        // Initialize custom input when rendering
                        initializeCustomInput(endpoint);
                        
                        return (
                        <Accordion key={endpoint.id} className="api-dev-accordion">
                            <AccordionSummary expandIcon={<ExpandMoreIcon />} className="api-dev-accordion-summary">
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, width: '100%' }}>
                                    <Chip 
                                        label={endpoint.method} 
                                        color={getMethodColor(endpoint.method)}
                    size="small"
                                        sx={{ minWidth: 60 }}
                                        className="api-dev-method-chip"
                                    />
                                    <Typography variant="body1" className="api-dev-endpoint-path">
                                        {endpoint.path}
                                    </Typography>
                                    <Typography variant="body2" color="text.secondary" sx={{ ml: 'auto' }}>
                                        {endpoint.description}
                                    </Typography>
                                    {endpoint.requiresAuth && (
                                        <Chip label="Auth Required" size="small" variant="outlined" />
                                    )}
                                </Box>
                            </AccordionSummary>
                            
                            <AccordionDetails>
                                <Grid container spacing={3}>
                                    <Grid item xs={12} md={6}>
                                        <Typography variant="h6" gutterBottom>Request</Typography>
                                        
                                        {endpoint.pathParams && (
                                            <Box sx={{ mb: 3 }}>
                                                <Typography variant="subtitle2" gutterBottom>Path Parameters:</Typography>
                <TextField
                                                    multiline
                                                    minRows={3}
                                                    maxRows={8}
                    fullWidth
                                                    value={customInputs[endpoint.id]?.pathParams || ''}
                                                    onChange={(e) => handleInputChange(endpoint.id, 'pathParams', e.target.value)}
                                                    placeholder={JSON.stringify(endpoint.pathParams, null, 2)}
                                                    sx={{ 
                                                        fontFamily: 'monospace',
                                                        fontSize: '0.875rem',
                                                        '& .MuiInputBase-input': {
                                                            fontFamily: 'monospace'
                                                        }
                                                    }}
                />
            </Box>
                                        )}
                                        
                                        {endpoint.queryParams && (
                                            <Box sx={{ mb: 3 }}>
                                                <Typography variant="subtitle2" gutterBottom>Query Parameters:</Typography>
                <TextField
                    multiline
                                                    minRows={3}
                                                    maxRows={8}
                    fullWidth
                                                    value={customInputs[endpoint.id]?.queryParams || ''}
                                                    onChange={(e) => handleInputChange(endpoint.id, 'queryParams', e.target.value)}
                                                    placeholder={JSON.stringify(endpoint.queryParams, null, 2)}
                                                    sx={{ 
                                                        fontFamily: 'monospace',
                                                        fontSize: '0.875rem',
                                                        '& .MuiInputBase-input': {
                                                            fontFamily: 'monospace'
                                                        }
                                                    }}
                                                />
                                            </Box>
                                        )}
                                        
                                        {endpoint.exampleInput && (endpoint.method === 'POST' || endpoint.method === 'PUT') && (
                                            <Box sx={{ mb: 3 }}>
                                                <Typography variant="subtitle2" gutterBottom>Request Body:</Typography>
            <TextField
                multiline
                minRows={6}
                                                    maxRows={15}
                fullWidth
                                                    value={customInputs[endpoint.id]?.body || ''}
                                                    onChange={(e) => handleInputChange(endpoint.id, 'body', e.target.value)}
                                                    placeholder={typeof endpoint.exampleInput === 'string' ? endpoint.exampleInput : JSON.stringify(endpoint.exampleInput, null, 2)}
                                                    sx={{ 
                                                        fontFamily: 'monospace',
                                                        fontSize: '0.875rem',
                                                        '& .MuiInputBase-input': {
                                                            fontFamily: 'monospace'
                                                        }
                                                    }}
                                                />
                                            </Box>
                                        )}
                                        
                                        <Typography variant="subtitle2" gutterBottom>Expected Response:</Typography>
                                        <Paper sx={{ p: 2, bgcolor: 'grey.50', mb: 3, maxHeight: 300, overflow: 'auto' }}>
                                            <pre style={{ margin: 0, fontSize: '0.875rem', whiteSpace: 'pre-wrap' }}>
                                                {typeof endpoint.exampleOutput === 'string' 
                                                    ? endpoint.exampleOutput 
                                                    : JSON.stringify(endpoint.exampleOutput, null, 2)}
                                            </pre>
                                        </Paper>
                                        
                                        <Button
                                            variant="contained"
                                            startIcon={loading[endpoint.id] ? <CircularProgress size={16} /> : <PlayArrowIcon />}
                                            onClick={() => handleTestEndpoint(endpoint)}
                                            disabled={loading[endpoint.id]}
                fullWidth
                                            size="large"
                                        >
                                            {loading[endpoint.id] ? 'Testing...' : 'Test Endpoint'}
                                        </Button>
                                    </Grid>
                                    
                                    <Grid item xs={12} md={6}>
                                        <Typography variant="h6" gutterBottom>Response</Typography>
                                        {responses[endpoint.id] ? (
                                            <Box>
                                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                                                    <Typography variant="subtitle2">Status:</Typography>
                                                    <Chip 
                                                        label={responses[endpoint.id].status}
                                                        color={responses[endpoint.id].error ? 'error' : 'success'}
                                                        size="small"
                                                    />
                                                </Box>
                                                <Paper sx={{ p: 2, bgcolor: responses[endpoint.id].error ? 'error.light' : 'success.light', minHeight: 400, maxHeight: 600, overflow: 'auto' }}>
                                                    <pre style={{ margin: 0, fontSize: '0.875rem', whiteSpace: 'pre-wrap' }}>
                                                        {typeof responses[endpoint.id].data === 'string' 
                                                            ? responses[endpoint.id].data 
                                                            : JSON.stringify(responses[endpoint.id].data, null, 2)}
                                                    </pre>
                                                </Paper>
                                            </Box>
                                        ) : (
                                            <Paper sx={{ p: 4, bgcolor: 'grey.100', textAlign: 'center', minHeight: 400, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                                <Typography color="text.secondary">
                                                    Click &quot;Test Endpoint&quot; to see the response
                                                </Typography>
                                            </Paper>
                                        )}
                                    </Grid>
                                </Grid>
                            </AccordionDetails>
                        </Accordion>
                        );
                    })}
                </Box>
            ))}
            </Box>
        </Box>
    );
};

export default ApiDevPage;
