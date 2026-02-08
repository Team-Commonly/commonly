import React, { useState, useEffect } from 'react';
import { Box, IconButton, Tooltip, CircularProgress, Typography } from '@mui/material';
import { Lightbulb as LightbulbIcon, Refresh as RefreshIcon } from '@mui/icons-material';
import axios from 'axios';
import './PodSummary.css';

const PodSummary = ({ podId, podName, podType, originalDescription }) => {
    const [summary, setSummary] = useState(null);
    const [loading, setLoading] = useState(false);
    const [showSummary, setShowSummary] = useState(false);
    const [summaryError, setSummaryError] = useState('');

    const normalizeSummary = (payload) => {
        if (!payload) return null;
        if (payload.summary && typeof payload.summary === 'object') return payload.summary;
        if (typeof payload === 'object' && (payload.content || payload._id)) return payload;
        return null;
    };

    const fetchSummary = async () => {
        try {
            setLoading(true);
            setSummaryError('');
            const token = localStorage.getItem('token');
            const response = await axios.get(`/api/summaries/pod/${podId}`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'x-auth-token': token
                }
            });
            setSummary(normalizeSummary(response.data));
        } catch (error) {
            console.error('Error fetching pod summary:', error);
            setSummary(null);
            setSummaryError(error?.response?.data?.error || 'Could not load summary');
        } finally {
            setLoading(false);
        }
    };

    const refreshSummary = async () => {
        try {
            setLoading(true);
            setSummaryError('');
            const token = localStorage.getItem('token');
            const response = await axios.post(`/api/summaries/pod/${podId}/refresh`, {}, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'x-auth-token': token
                }
            });
            setSummary(normalizeSummary(response.data));
            setShowSummary(true);
        } catch (error) {
            console.error('Error refreshing pod summary:', error);
            setSummaryError(error?.response?.data?.error || 'Could not refresh summary');
            await fetchSummary();
            // Keep toggle behavior predictable: show summary view even when refresh fails.
            setShowSummary(true);
        } finally {
            setLoading(false);
        }
    };

    const handleToggleSummary = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        if (!showSummary) {
            await refreshSummary();
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
                    {showSummary && (
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
                        <>
                            <Typography variant="body2" className="ai-summary-text">
                                {summary.content || 'No recent activity to summarize'}
                            </Typography>
                            {summaryError ? (
                                <Typography variant="caption" color="error" className="no-activity">
                                    {summaryError}
                                </Typography>
                            ) : null}
                        </>
                    ) : (
                        <>
                            <Typography variant="body2" color="text.secondary" className="no-activity">
                                No recent activity to summarize
                            </Typography>
                            {summaryError ? (
                                <Typography variant="caption" color="error" className="no-activity">
                                    {summaryError}
                                </Typography>
                            ) : null}
                        </>
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
