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
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';

const ApiDevPage = () => {
    const [responses, setResponses] = useState({});
    const [loading, setLoading] = useState({});
    const [customInputs, setCustomInputs] = useState({});
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
                headers: {}
            };

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

    return (
        <Box sx={{ maxWidth: 1200, mx: 'auto', p: 3, mt: 8 }}>
            <Typography variant="h4" sx={{ mb: 3 }}>API Development Tools</Typography>
            
            {!token && (
                <Alert severity="warning" sx={{ mb: 3 }}>
                    You are not logged in. Some endpoints that require authentication will fail.
                </Alert>
            )}

            {apiEndpoints.map((category) => (
                <Box key={category.category} sx={{ mb: 4 }}>
                    <Typography variant="h5" sx={{ mb: 2, color: 'primary.main' }}>
                        {category.category}
                    </Typography>
                    
                    {category.endpoints.map((endpoint) => {
                        // Initialize custom input when rendering
                        initializeCustomInput(endpoint);
                        
                        return (
                        <Accordion key={endpoint.id} sx={{ mb: 2 }}>
                            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, width: '100%' }}>
                                    <Chip 
                                        label={endpoint.method} 
                                        color={getMethodColor(endpoint.method)}
                    size="small"
                                        sx={{ minWidth: 60 }}
                                    />
                                    <Typography variant="body1" sx={{ fontFamily: 'monospace' }}>
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
    );
};

export default ApiDevPage;
