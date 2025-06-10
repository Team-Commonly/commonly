import React, { useState, useEffect } from 'react';
import { Box, Typography, IconButton, Tooltip, CircularProgress } from '@mui/material';
import { Lightbulb as LightbulbIcon, Refresh as RefreshIcon } from '@mui/icons-material';
import axios from 'axios';
import './PodSummary.css';

const PodSummary = ({ podId, podName, podType, originalDescription }) => {
    const [summary, setSummary] = useState(null);
    const [loading, setLoading] = useState(false);
    const [showSummary, setShowSummary] = useState(false);

    const fetchSummary = async () => {
        try {
            setLoading(true);
            const token = localStorage.getItem('token');
            const response = await axios.get(`/api/summaries/pod/${podId}`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            setSummary(response.data);
        } catch (error) {
            console.error('Error fetching pod summary:', error);
            setSummary(null);
        } finally {
            setLoading(false);
        }
    };

    const refreshSummary = async () => {
        try {
            setLoading(true);
            const token = localStorage.getItem('token');
            const response = await axios.post(`/api/summaries/pod/${podId}/refresh`, {}, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            setSummary(response.data.summary);
            setShowSummary(true);
        } catch (error) {
            console.error('Error refreshing pod summary:', error);
            await fetchSummary();
        } finally {
            setLoading(false);
        }
    };

    const handleToggleSummary = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        if (!showSummary) {
            if (!summary) {
                await refreshSummary();
            } else {
                setShowSummary(true);
            }
        } else {
            setShowSummary(false);
        }
    };

    const handleRefresh = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await refreshSummary();
    };

    useEffect(() => {
        fetchSummary();
    }, [podId]);

    return (
        <Box className="pod-summary-container">
            <Box className="summary-header">
                <Typography variant="body2" className="summary-label">
                    {showSummary ? 'AI Summary' : 'Description'}
                </Typography>
                <Box className="summary-controls">
                    <Tooltip title={showSummary ? "Show description" : "Show AI summary"}>
                        <IconButton 
                            size="small" 
                            onClick={handleToggleSummary}
                            disabled={loading}
                            className={`summary-toggle ${showSummary ? 'active' : ''}`}
                        >
                            {loading ? (
                                <CircularProgress size={14} />
                            ) : (
                                <LightbulbIcon />
                            )}
                        </IconButton>
                    </Tooltip>
                    {showSummary && summary && (
                        <Tooltip title="Refresh summary">
                            <IconButton 
                                size="small" 
                                onClick={handleRefresh}
                                disabled={loading}
                                className="refresh-btn"
                            >
                                <RefreshIcon />
                            </IconButton>
                        </Tooltip>
                    )}
                </Box>
            </Box>
            
            <Box className="summary-content">
                {showSummary ? (
                    summary ? (
                        <Typography variant="body2" className="ai-summary-text">
                            {summary.content}
                        </Typography>
                    ) : (
                        <Typography variant="body2" color="text.secondary" className="no-activity">
                            No recent activity to summarize
                        </Typography>
                    )
                ) : (
                    <Typography variant="body2" color="text.secondary" className="description-text">
                        {originalDescription || 'No description provided'}
                    </Typography>
                )}
            </Box>
        </Box>
    );
};

export default PodSummary; 