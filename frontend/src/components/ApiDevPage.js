import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './ApiDevPage.css';
import {
    Box,
    Button,
    TextField,
    MenuItem,
    Typography,
} from '@mui/material';

const ApiDevPage = () => {
    const [method, setMethod] = useState('GET');
    const [endpoint, setEndpoint] = useState('/api');
    const [body, setBody] = useState('');
    const [response, setResponse] = useState('');
    const [docs, setDocs] = useState('');

    useEffect(() => {
        axios.get('/api/docs/backend')
            .then((res) => setDocs(res.data))
            .catch(() => setDocs('Failed to load documentation'));
    }, []);

    const handleSend = async () => {
        try {
            const options = {
                method,
                url: endpoint,
            };
            if (body && method !== 'GET') {
                options.data = JSON.parse(body);
            }
            const res = await axios(options);
            setResponse(JSON.stringify(res.data, null, 2));
        } catch (err) {
            if (err.response) {
                setResponse(JSON.stringify(err.response.data, null, 2));
            } else {
                setResponse(err.message);
            }
        }
    };

    return (
        <Box className="api-dev-page" sx={{ p: 2 }}>
            <Typography variant="h4" sx={{ mb: 2 }}>API Dev Tools</Typography>
            <Box sx={{ display: 'flex', gap: 1, mb: 2 }}>
                <TextField
                    select
                    label="Method"
                    value={method}
                    onChange={(e) => setMethod(e.target.value)}
                    size="small"
                >
                    {['GET', 'POST', 'PUT', 'DELETE'].map((m) => (
                        <MenuItem key={m} value={m}>{m}</MenuItem>
                    ))}
                </TextField>
                <TextField
                    label="Endpoint"
                    value={endpoint}
                    onChange={(e) => setEndpoint(e.target.value)}
                    fullWidth
                    size="small"
                />
            </Box>
            {method !== 'GET' && (
                <TextField
                    label="Body JSON"
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    multiline
                    minRows={4}
                    fullWidth
                    sx={{ mb: 2 }}
                />
            )}
            <Button variant="contained" onClick={handleSend} sx={{ mb: 2 }}>Send</Button>
            <Typography variant="subtitle1">Response</Typography>
            <TextField
                value={response}
                multiline
                minRows={6}
                fullWidth
                InputProps={{ readOnly: true }}
                sx={{ mb: 4 }}
            />
            <Typography variant="h5" sx={{ mb: 1 }}>Backend Documentation</Typography>
            <TextField
                value={docs}
                multiline
                minRows={10}
                fullWidth
                InputProps={{ readOnly: true }}
            />
        </Box>
    );
};

export default ApiDevPage;
