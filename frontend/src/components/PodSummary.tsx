import React, { useState, useEffect } from 'react';
import { Box, IconButton, Tooltip, CircularProgress, Typography } from '@mui/material';
import { Lightbulb as LightbulbIcon, Refresh as RefreshIcon } from '@mui/icons-material';
import axios from 'axios';
import './PodSummary.css';

interface SummaryData {
  _id?: string;
  content?: string;
  summary?: SummaryData;
}

interface PodSummaryProps {
  podId: string;
  title?: string;
  originalDescription?: string;
}

const PodSummary: React.FC<PodSummaryProps> = ({ podId, title, originalDescription }) => {
    const viewPreferenceKey = `pod-summary-view:${podId}`;
    const [summary, setSummary] = useState<SummaryData | null>(null);
    const [loading, setLoading] = useState(false);
    const [showSummary, setShowSummary] = useState(() => {
        try {
            return window.localStorage.getItem(viewPreferenceKey) !== 'description';
        } catch (error) {
            return true;
        }
    });
    const [summaryError, setSummaryError] = useState('');

    const normalizeSummary = (payload: unknown): SummaryData | null => {
        if (!payload) return null;
        const p = payload as SummaryData;
        if (p.summary && typeof p.summary === 'object') return p.summary;
        if (typeof p === 'object' && (p.content || p._id)) return p;
        return null;
    };

    const fetchSummary = async (): Promise<void> => {
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
            const err = error as { response?: { data?: { error?: string } } };
            setSummaryError(err?.response?.data?.error || 'Could not load summary');
        } finally {
            setLoading(false);
        }
    };

    const refreshSummary = async (): Promise<void> => {
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
            try {
                window.localStorage.setItem(viewPreferenceKey, 'summary');
            } catch (error) {
                // Ignore localStorage write issues.
            }
        } catch (error) {
            console.error('Error refreshing pod summary:', error);
            const err = error as { response?: { data?: { error?: string } } };
            setSummaryError(err?.response?.data?.error || 'Could not refresh summary');
            await fetchSummary();
            // Keep toggle behavior predictable: show summary view even when refresh fails.
            setShowSummary(true);
            try {
                window.localStorage.setItem(viewPreferenceKey, 'summary');
            } catch (writeError) {
                // Ignore localStorage write issues.
            }
        } finally {
            setLoading(false);
        }
    };

    const handleToggleSummary = async (e: React.MouseEvent): Promise<void> => {
        e.preventDefault();
        e.stopPropagation();

        if (!showSummary) {
            setShowSummary(true);
            try {
                window.localStorage.setItem(viewPreferenceKey, 'summary');
            } catch (error) {
                // Ignore localStorage write issues.
            }
        } else {
            setShowSummary(false);
            try {
                window.localStorage.setItem(viewPreferenceKey, 'description');
            } catch (error) {
                // Ignore localStorage write issues.
            }
        }
    };

    const handleRefresh = async (e: React.MouseEvent): Promise<void> => {
        e.preventDefault();
        e.stopPropagation();
        await refreshSummary();
    };

    useEffect(() => {
        fetchSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [podId]);

    return (
        <Box className="pod-summary-container">
            <Box className="summary-title-row">
                {title ? (
                    <Typography variant="h5" component="div" className="pod-card-title">
                        {title}
                    </Typography>
                ) : <Box />}
                <Box className="summary-controls">
                    <Tooltip title={showSummary ? "Show description" : "Show AI summary"}>
                        <IconButton
                            size="small"
                            onClick={handleToggleSummary}
                            disabled={loading}
                            className={`summary-toggle ${showSummary ? 'active' : ''}`}
                            aria-label={showSummary ? 'Show description' : 'Show AI summary'}
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
                                aria-label="Refresh summary"
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
