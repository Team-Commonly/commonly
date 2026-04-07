import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  Grid,
  MenuItem,
  Pagination,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableContainer,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import axios from '../../utils/axiosConfig';

const DEFAULT_PAGE_SIZE = 5;

interface User {
  id: string;
  username: string;
  email: string;
  role: string;
  verified: boolean;
}

interface Invitation {
  id: string;
  code: string;
  isActive: boolean;
  useCount: number;
  maxUses: number;
  note?: string;
  expiresAt?: string;
}

interface InvitationCode {
  code: string;
}

interface WaitlistRequest {
  id: string;
  email: string;
  status: string;
  name?: string;
  note?: string;
  invitationCode?: InvitationCode;
}

interface InviteForm {
  code: string;
  note: string;
  maxUses: number | string;
  expiresAt: string;
}

interface FetchDataOptions {
  nextInvitationsPage?: number;
  nextWaitlistPage?: number;
}

interface AdminUsersProps {
  embedded?: boolean;
}

const AdminUsers: React.FC<AdminUsersProps> = ({ embedded = false }) => {
  const [loading, setLoading] = useState(false);
  const [savingRoleId, setSavingRoleId] = useState('');
  const [deletingUserId, setDeletingUserId] = useState('');
  const [savingInvite, setSavingInvite] = useState(false);
  const [revokingInviteId, setRevokingInviteId] = useState('');
  const [sendingWaitlistId, setSendingWaitlistId] = useState('');
  const [updatingWaitlistId, setUpdatingWaitlistId] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [users, setUsers] = useState<User[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [waitlistRequests, setWaitlistRequests] = useState<WaitlistRequest[]>([]);
  const [userQuery, setUserQuery] = useState('');
  const [userRoleFilter, setUserRoleFilter] = useState('all');
  const [invitationsPage, setInvitationsPage] = useState(1);
  const [invitationsTotalPages, setInvitationsTotalPages] = useState(1);
  const [waitlistPage, setWaitlistPage] = useState(1);
  const [waitlistTotalPages, setWaitlistTotalPages] = useState(1);

  const [inviteForm, setInviteForm] = useState<InviteForm>({
    code: '',
    note: '',
    maxUses: 1,
    expiresAt: '',
  });

  const fetchData = async ({ nextInvitationsPage, nextWaitlistPage }: FetchDataOptions = {}): Promise<void> => {
    try {
      setLoading(true);
      setError('');
      const params = new URLSearchParams();
      const invitePage = nextInvitationsPage || invitationsPage;
      const nextWaitPage = nextWaitlistPage || waitlistPage;
      if (userQuery.trim()) params.set('q', userQuery.trim());
      if (userRoleFilter !== 'all') params.set('role', userRoleFilter);

      const [usersRes, invitationsRes, waitlistRes] = await Promise.all([
        axios.get(`/api/admin/users?${params.toString()}`),
        axios.get('/api/admin/users/invitations', {
          params: {
            page: invitePage,
            limit: DEFAULT_PAGE_SIZE,
          },
        }),
        axios.get('/api/admin/users/waitlist', {
          params: {
            status: 'all',
            page: nextWaitPage,
            limit: DEFAULT_PAGE_SIZE,
          },
        }),
      ]);

      setUsers((usersRes.data as { users?: User[] })?.users || []);
      setInvitations((invitationsRes.data as { invitations?: Invitation[] })?.invitations || []);
      setInvitationsTotalPages(Math.max(1, (invitationsRes.data as { totalPages?: number })?.totalPages || 1));
      setWaitlistRequests((waitlistRes.data as { requests?: WaitlistRequest[] })?.requests || []);
      setWaitlistTotalPages(Math.max(1, (waitlistRes.data as { totalPages?: number })?.totalPages || 1));
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      setError(e.response?.data?.error || 'Failed to load admin users data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [invitationsPage, waitlistPage]);

  const handleChangeRole = async (userId: string, role: string): Promise<void> => {
    try {
      setSavingRoleId(userId);
      setError('');
      setSuccess('');
      await axios.patch(`/api/admin/users/${userId}/role`, { role });
      setSuccess('User role updated.');
      await fetchData();
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      setError(e.response?.data?.error || 'Failed to update user role');
    } finally {
      setSavingRoleId('');
    }
  };

  const handleDeleteUser = async (userToDelete: User): Promise<void> => {
    const confirmed = window.confirm(`Delete user "${userToDelete.username}"? This cannot be undone.`);
    if (!confirmed) return;

    try {
      setDeletingUserId(userToDelete.id);
      setError('');
      setSuccess('');
      await axios.delete(`/api/admin/users/${userToDelete.id}`);
      setSuccess('User deleted.');
      await fetchData();
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      setError(e.response?.data?.error || 'Failed to delete user');
    } finally {
      setDeletingUserId('');
    }
  };

  const handleCreateInvitation = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    try {
      setSavingInvite(true);
      setError('');
      setSuccess('');
      await axios.post('/api/admin/users/invitations', {
        code: inviteForm.code || undefined,
        note: inviteForm.note,
        maxUses: Number(inviteForm.maxUses),
        expiresAt: inviteForm.expiresAt || undefined,
      });
      setSuccess('Invitation code generated.');
      setInviteForm({
        code: '',
        note: '',
        maxUses: 1,
        expiresAt: '',
      });
      setInvitationsPage(1);
      await fetchData({ nextInvitationsPage: 1 });
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      setError(e.response?.data?.error || 'Failed to create invitation code');
    } finally {
      setSavingInvite(false);
    }
  };

  const handleRevokeInvitation = async (invitationId: string): Promise<void> => {
    try {
      setRevokingInviteId(invitationId);
      setError('');
      setSuccess('');
      await axios.post(`/api/admin/users/invitations/${invitationId}/revoke`);
      setSuccess('Invitation code revoked.');
      await fetchData();
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      setError(e.response?.data?.error || 'Failed to revoke invitation code');
    } finally {
      setRevokingInviteId('');
    }
  };

  const handleSendWaitlistInvite = async (requestId: string): Promise<void> => {
    try {
      setSendingWaitlistId(requestId);
      setError('');
      setSuccess('');
      await axios.post(`/api/admin/users/waitlist/${requestId}/send-invitation`, {
        maxUses: 1,
      });
      setSuccess('Invitation code generated and emailed to waitlist requester.');
      await fetchData();
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      setError(e.response?.data?.error || 'Failed to send invitation email');
    } finally {
      setSendingWaitlistId('');
    }
  };

  const handleUpdateWaitlistStatus = async (requestId: string, status: string): Promise<void> => {
    try {
      setUpdatingWaitlistId(requestId);
      setError('');
      setSuccess('');
      await axios.patch(`/api/admin/users/waitlist/${requestId}`, { status });
      setSuccess('Waitlist request updated.');
      await fetchData();
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      setError(e.response?.data?.error || 'Failed to update waitlist request');
    } finally {
      setUpdatingWaitlistId('');
    }
  };

  return (
    <Box sx={{ maxWidth: 1200, mx: 'auto', p: { xs: 2, md: 3 } }}>
      {!embedded && (
        <>
          <Typography variant="h4" sx={{ fontWeight: 700, mb: 1 }}>
            Admin Users, Waitlist & Invitations
          </Typography>
          <Typography sx={{ color: 'text.secondary', mb: 3 }}>
            Manage global admins, review waitlist requests, and send invitation codes for invite-only registration.
          </Typography>
        </>
      )}

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {success && <Alert severity="success" sx={{ mb: 2 }}>{success}</Alert>}

      <Grid container spacing={2.5}>
        <Grid item xs={12} md={7}>
          <Card sx={{ borderRadius: 3 }}>
            <CardContent>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
                <TextField
                  label="Search users"
                  size="small"
                  fullWidth
                  value={userQuery}
                  onChange={(e) => setUserQuery(e.target.value)}
                />
                <TextField
                  select
                  label="Role"
                  size="small"
                  value={userRoleFilter}
                  onChange={(e) => setUserRoleFilter(e.target.value)}
                  sx={{ minWidth: 140 }}
                >
                  <MenuItem value="all">All</MenuItem>
                  <MenuItem value="admin">Admins</MenuItem>
                  <MenuItem value="user">Users</MenuItem>
                </TextField>
                <Button variant="outlined" onClick={() => fetchData()}>
                  Refresh
                </Button>
              </Stack>

              <Divider sx={{ mb: 2 }} />

              {loading ? (
                <Box sx={{ py: 4, display: 'flex', justifyContent: 'center' }}>
                  <CircularProgress size={28} />
                </Box>
              ) : (
                <TableContainer sx={{ border: '1px solid rgba(148,163,184,0.2)', borderRadius: 2, overflowX: 'auto' }}>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>User</TableCell>
                        <TableCell>Email</TableCell>
                        <TableCell>Role</TableCell>
                        <TableCell align="right">Actions</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {users.map((user) => (
                        <TableRow key={user.id}>
                          <TableCell>
                            <Stack direction="row" spacing={1} alignItems="center">
                              <Typography variant="body2">{user.username}</Typography>
                              {user.verified ? (
                                <Chip label="Verified" size="small" color="success" variant="outlined" />
                              ) : (
                                <Chip label="Unverified" size="small" variant="outlined" />
                              )}
                            </Stack>
                          </TableCell>
                          <TableCell>{user.email}</TableCell>
                          <TableCell>
                            <Chip
                              size="small"
                              label={user.role === 'admin' ? 'Admin' : 'User'}
                              color={user.role === 'admin' ? 'primary' : 'default'}
                              variant={user.role === 'admin' ? 'filled' : 'outlined'}
                            />
                          </TableCell>
                          <TableCell align="right">
                            <Stack direction="row" justifyContent="flex-end" spacing={0.5} sx={{ flexWrap: 'wrap' }}>
                              {user.role === 'admin' ? (
                                <Button
                                  size="small"
                                  color="warning"
                                  disabled={savingRoleId === user.id}
                                  onClick={() => handleChangeRole(user.id, 'user')}
                                >
                                  Set User
                                </Button>
                              ) : (
                                <Button
                                  size="small"
                                  color="primary"
                                  disabled={savingRoleId === user.id}
                                  onClick={() => handleChangeRole(user.id, 'admin')}
                                >
                                  Set Admin
                                </Button>
                              )}
                              <Button
                                size="small"
                                color="error"
                                disabled={deletingUserId === user.id}
                                onClick={() => handleDeleteUser(user)}
                              >
                                Delete
                              </Button>
                            </Stack>
                          </TableCell>
                        </TableRow>
                      ))}
                      {!users.length && (
                        <TableRow>
                          <TableCell colSpan={4} align="center">
                            <Typography variant="body2" color="text.secondary">No users found.</Typography>
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={5}>
          <Card sx={{ borderRadius: 3, mb: 2.5 }}>
            <CardContent>
              <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>
                Waitlist Requests
              </Typography>
              <Stack spacing={1}>
                {waitlistRequests.map((request) => (
                  <Box
                    key={request.id}
                    sx={{
                      border: '1px solid rgba(148,163,184,0.25)',
                      borderRadius: 2,
                      p: 1.25,
                    }}
                  >
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Typography sx={{ fontWeight: 600 }}>
                        {request.email}
                      </Typography>
                      <Chip
                        size="small"
                        label={request.status}
                        color={request.status === 'pending' ? 'warning' : request.status === 'invited' ? 'success' : 'default'}
                        variant={request.status === 'closed' ? 'outlined' : 'filled'}
                      />
                    </Stack>
                    {request.name && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                        Name: {request.name}
                      </Typography>
                    )}
                    {request.note && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        Use case: {request.note}
                      </Typography>
                    )}
                    {request.invitationCode?.code && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        Invite: {request.invitationCode.code}
                      </Typography>
                    )}
                    <Stack direction="row" spacing={1} sx={{ mt: 0.75 }}>
                      {request.status !== 'invited' && (
                        <Button
                          size="small"
                          variant="contained"
                          disabled={sendingWaitlistId === request.id}
                          onClick={() => handleSendWaitlistInvite(request.id)}
                        >
                          {sendingWaitlistId === request.id ? 'Sending...' : 'Send Invite Email'}
                        </Button>
                      )}
                      {request.status !== 'closed' && (
                        <Button
                          size="small"
                          color="inherit"
                          disabled={updatingWaitlistId === request.id}
                          onClick={() => handleUpdateWaitlistStatus(request.id, 'closed')}
                        >
                          Close
                        </Button>
                      )}
                    </Stack>
                  </Box>
                ))}
                {!waitlistRequests.length && (
                  <Typography variant="body2" color="text.secondary">
                    No waitlist requests yet.
                  </Typography>
                )}
              </Stack>
              <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
                <Pagination
                  page={waitlistPage}
                  count={waitlistTotalPages}
                  onChange={(_event: React.ChangeEvent<unknown>, page: number) => setWaitlistPage(page)}
                  size="small"
                />
              </Box>
            </CardContent>
          </Card>

          <Card sx={{ borderRadius: 3, mb: 2.5 }}>
            <CardContent>
              <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>
                Generate Invitation Code
              </Typography>
              <Box component="form" onSubmit={handleCreateInvitation}>
                <Stack spacing={1.5}>
                  <TextField
                    label="Custom code (optional)"
                    size="small"
                    value={inviteForm.code}
                    onChange={(e) => setInviteForm((prev) => ({ ...prev, code: e.target.value }))}
                    placeholder="Auto-generated if empty"
                  />
                  <TextField
                    label="Note (optional)"
                    size="small"
                    value={inviteForm.note}
                    onChange={(e) => setInviteForm((prev) => ({ ...prev, note: e.target.value }))}
                  />
                  <TextField
                    label="Max uses"
                    size="small"
                    type="number"
                    inputProps={{ min: 1 }}
                    value={inviteForm.maxUses}
                    onChange={(e) => setInviteForm((prev) => ({ ...prev, maxUses: e.target.value }))}
                  />
                  <TextField
                    label="Expires at (optional)"
                    size="small"
                    type="datetime-local"
                    InputLabelProps={{ shrink: true }}
                    value={inviteForm.expiresAt}
                    onChange={(e) => setInviteForm((prev) => ({ ...prev, expiresAt: e.target.value }))}
                  />
                  <Button type="submit" variant="contained" disabled={savingInvite}>
                    {savingInvite ? 'Generating...' : 'Generate Code'}
                  </Button>
                </Stack>
              </Box>
            </CardContent>
          </Card>

          <Card sx={{ borderRadius: 3 }}>
            <CardContent>
              <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>
                Invitation Codes
              </Typography>
              <Stack spacing={1}>
                {invitations.map((invite) => (
                  <Box
                    key={invite.id}
                    sx={{
                      border: '1px solid rgba(148,163,184,0.25)',
                      borderRadius: 2,
                      p: 1.25,
                    }}
                  >
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Typography sx={{ fontFamily: 'monospace', fontWeight: 700 }}>
                        {invite.code}
                      </Typography>
                      <Chip
                        size="small"
                        label={invite.isActive ? 'Active' : 'Revoked'}
                        color={invite.isActive ? 'success' : 'default'}
                        variant={invite.isActive ? 'filled' : 'outlined'}
                      />
                    </Stack>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                      Uses: {invite.useCount}/{invite.maxUses}
                    </Typography>
                    {invite.note && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        Note: {invite.note}
                      </Typography>
                    )}
                    {invite.expiresAt && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        Expires: {new Date(invite.expiresAt).toLocaleString()}
                      </Typography>
                    )}
                    {invite.isActive && (
                      <Button
                        size="small"
                        color="warning"
                        sx={{ mt: 0.75 }}
                        disabled={revokingInviteId === invite.id}
                        onClick={() => handleRevokeInvitation(invite.id)}
                      >
                        Revoke
                      </Button>
                    )}
                  </Box>
                ))}
                {!invitations.length && (
                  <Typography variant="body2" color="text.secondary">
                    No invitation codes yet.
                  </Typography>
                )}
              </Stack>
              <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
                <Pagination
                  page={invitationsPage}
                  count={invitationsTotalPages}
                  onChange={(_event: React.ChangeEvent<unknown>, page: number) => setInvitationsPage(page)}
                  size="small"
                />
              </Box>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
};

export default AdminUsers;
