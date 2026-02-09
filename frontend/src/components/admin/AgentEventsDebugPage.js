import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Grid,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { Refresh as RefreshIcon } from '@mui/icons-material';
import axios from 'axios';

const formatDate = (value) => {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
};

const ageMinutes = (value) => {
  if (!value) return null;
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.floor((Date.now() - ts) / 60000));
};

const AgentEventsDebugPage = ({ embedded = false }) => {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState(null);

  const fetchData = useCallback(async ({ silent = false } = {}) => {
    try {
      if (!silent) setLoading(true);
      if (silent) setRefreshing(true);
      setError('');
      const token = localStorage.getItem('token');
      const response = await axios.get('/api/admin/agents/events?limitPending=100&limitRecent=100', {
        headers: { Authorization: `Bearer ${token}` },
      });
      setData(response.data || null);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load agent events');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const queue = data?.queue || {};
  const stalePendingCount = Number(queue.stalePendingCount || 0);
  const deliveredByOutcome = queue?.deliveredByOutcome || {};
  const heartbeatInstallations = useMemo(() => data?.heartbeatInstallations || [], [data]);
  const failedByAgent = useMemo(() => data?.failedByAgent || [], [data]);
  const failedEvents = useMemo(() => data?.failedEvents || [], [data]);
  const recentDeliveredHeartbeats = useMemo(() => data?.recentDeliveredHeartbeats || [], [data]);

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="320px">
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
        {!embedded && <Typography variant="h4">Agent Events Debug</Typography>}
        <Button
          variant="contained"
          startIcon={<RefreshIcon />}
          onClick={() => fetchData({ silent: true })}
          disabled={refreshing}
        >
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </Button>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid item xs={12} md={3}>
          <Card><CardContent><Typography variant="body2" color="text.secondary">Pending</Typography><Typography variant="h4">{queue.pending || 0}</Typography></CardContent></Card>
        </Grid>
        <Grid item xs={12} md={3}>
          <Card><CardContent><Typography variant="body2" color="text.secondary">Delivered</Typography><Typography variant="h4">{queue.delivered || 0}</Typography></CardContent></Card>
        </Grid>
        <Grid item xs={12} md={3}>
          <Card><CardContent><Typography variant="body2" color="text.secondary">Failed</Typography><Typography variant="h4">{queue.failed || 0}</Typography></CardContent></Card>
        </Grid>
        <Grid item xs={12} md={3}>
          <Card><CardContent><Typography variant="body2" color="text.secondary">Stale Pending ({queue.stalePendingMinutes || 30}m)</Typography><Typography variant="h4">{stalePendingCount}</Typography></CardContent></Card>
        </Grid>
      </Grid>

      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom>Delivered Outcomes</Typography>
          <Typography variant="body2" color="text.secondary">
            posted: {deliveredByOutcome.posted || 0}
            {' | '}
            no_action: {deliveredByOutcome.no_action || 0}
            {' | '}
            skipped: {deliveredByOutcome.skipped || 0}
            {' | '}
            acknowledged-only: {deliveredByOutcome.acknowledged || 0}
            {' | '}
            error: {deliveredByOutcome.error || 0}
          </Typography>
        </CardContent>
      </Card>

      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom>Pending By Agent</Typography>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Agent</TableCell>
                  <TableCell>Instance</TableCell>
                  <TableCell>Count</TableCell>
                  <TableCell>Oldest</TableCell>
                  <TableCell>Newest</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(data?.pendingByAgent || []).map((row) => (
                  <TableRow key={`${row.agentName}:${row.instanceId}`}>
                    <TableCell>{row.agentName}</TableCell>
                    <TableCell>{row.instanceId}</TableCell>
                    <TableCell>{row.count}</TableCell>
                    <TableCell>{formatDate(row.oldestCreatedAt)}</TableCell>
                    <TableCell>{formatDate(row.newestCreatedAt)}</TableCell>
                  </TableRow>
                ))}
                {(data?.pendingByAgent || []).length === 0 && (
                  <TableRow><TableCell colSpan={5}>No pending events</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>

      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom>Failed By Agent</Typography>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Agent</TableCell>
                  <TableCell>Instance</TableCell>
                  <TableCell>Count</TableCell>
                  <TableCell>Newest</TableCell>
                  <TableCell>Last Error</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {failedByAgent.map((row) => (
                  <TableRow key={`${row.agentName}:${row.instanceId}`}>
                    <TableCell>{row.agentName}</TableCell>
                    <TableCell>{row.instanceId}</TableCell>
                    <TableCell>{row.count}</TableCell>
                    <TableCell>{formatDate(row.newestCreatedAt)}</TableCell>
                    <TableCell sx={{ maxWidth: 520, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {row.newestError || '—'}
                    </TableCell>
                  </TableRow>
                ))}
                {failedByAgent.length === 0 && (
                  <TableRow><TableCell colSpan={5}>No failed events</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>

      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom>Heartbeat Status</Typography>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Agent</TableCell>
                  <TableCell>Instance</TableCell>
                  <TableCell>Pod</TableCell>
                  <TableCell>Interval (min)</TableCell>
                  <TableCell>Last Heartbeat</TableCell>
                  <TableCell>Age (min)</TableCell>
                  <TableCell>Status</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {heartbeatInstallations.map((row) => (
                  <TableRow key={`${row.agentName}:${row.instanceId}:${row.podId}`}>
                    <TableCell>{row.agentName}</TableCell>
                    <TableCell>{row.instanceId}</TableCell>
                    <TableCell>{row.podId}</TableCell>
                    <TableCell>{row.everyMinutes}</TableCell>
                    <TableCell>{formatDate(row.lastHeartbeatAt)}</TableCell>
                    <TableCell>{ageMinutes(row.lastHeartbeatAt) ?? '—'}</TableCell>
                    <TableCell>{row.lastHeartbeatStatus || 'none'}</TableCell>
                  </TableRow>
                ))}
                {heartbeatInstallations.length === 0 && (
                  <TableRow><TableCell colSpan={7}>No active installations</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>Pending Events (Oldest First)</Typography>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Created</TableCell>
                  <TableCell>Agent</TableCell>
                  <TableCell>Instance</TableCell>
                  <TableCell>Type</TableCell>
                  <TableCell>Pod</TableCell>
                  <TableCell>Attempts</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(data?.pendingEvents || []).map((event) => (
                  <TableRow key={event.id}>
                    <TableCell>{formatDate(event.createdAt)}</TableCell>
                    <TableCell>{event.agentName}</TableCell>
                    <TableCell>{event.instanceId}</TableCell>
                    <TableCell>{event.type}</TableCell>
                    <TableCell>{event.podId}</TableCell>
                    <TableCell>{event.attempts}</TableCell>
                  </TableRow>
                ))}
                {(data?.pendingEvents || []).length === 0 && (
                  <TableRow><TableCell colSpan={6}>No pending events</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>

      <Card sx={{ mt: 2 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom>Recent Delivered Heartbeats</Typography>
          <TableContainer sx={{ mb: 2 }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Created</TableCell>
                  <TableCell>Agent</TableCell>
                  <TableCell>Instance</TableCell>
                  <TableCell>Pod</TableCell>
                  <TableCell>Outcome</TableCell>
                  <TableCell>Reason</TableCell>
                  <TableCell>Message</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {recentDeliveredHeartbeats.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell>{formatDate(event.createdAt)}</TableCell>
                    <TableCell>{event.agentName}</TableCell>
                    <TableCell>{event.instanceId}</TableCell>
                    <TableCell>{event.podId}</TableCell>
                    <TableCell>{event.delivery?.outcome || 'acknowledged'}</TableCell>
                    <TableCell sx={{ maxWidth: 420, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {event.delivery?.reason || '—'}
                    </TableCell>
                    <TableCell>{event.delivery?.messageId || '—'}</TableCell>
                  </TableRow>
                ))}
                {recentDeliveredHeartbeats.length === 0 && (
                  <TableRow><TableCell colSpan={7}>No delivered heartbeat events</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>

          <Typography variant="h6" gutterBottom>Recent Failed Events</Typography>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Created</TableCell>
                  <TableCell>Agent</TableCell>
                  <TableCell>Instance</TableCell>
                  <TableCell>Type</TableCell>
                  <TableCell>Pod</TableCell>
                  <TableCell>Attempts</TableCell>
                  <TableCell>Error</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {failedEvents.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell>{formatDate(event.createdAt)}</TableCell>
                    <TableCell>{event.agentName}</TableCell>
                    <TableCell>{event.instanceId}</TableCell>
                    <TableCell>{event.type}</TableCell>
                    <TableCell>{event.podId}</TableCell>
                    <TableCell>{event.attempts}</TableCell>
                    <TableCell sx={{ maxWidth: 640, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {event.error || '—'}
                    </TableCell>
                  </TableRow>
                ))}
                {failedEvents.length === 0 && (
                  <TableRow><TableCell colSpan={7}>No failed events</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>
    </Box>
  );
};

export default AgentEventsDebugPage;
