// v2-native admin surface for waitlist review + invitation-code management.
// Wires onto the already-shipped backend at /api/admin/users/* (all behind
// auth + adminAuth). The route element wraps this in <ProtectedRoute
// requireAdmin> + the V2FeaturePage chrome (see V2App.tsx), so this component
// only renders the page body. Styled exclusively with v2.css tokens — no
// @mui/material imports.
//
// Two sections:
//   1. Waitlist — list/search/filter requests, send an invitation email
//      (graceful 503 fallback when SMTP2GO isn't configured), reopen an
//      already-invited row so it can be re-sent.
//   2. Invitation codes — list existing codes, generate a new one (shown
//      once with copy-to-clipboard), revoke.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useV2Api } from '../hooks/useV2Api';

interface AdminRef {
  id: string | null;
  username: string;
  email: string;
}

interface InvitationCodeRef {
  id: string | null;
  code: string;
}

type WaitlistStatus = 'pending' | 'invited' | 'closed';

interface WaitlistRow {
  id: string;
  email: string;
  name: string;
  organization: string;
  useCase: string;
  note: string;
  status: WaitlistStatus | string;
  createdAt: string | null;
  updatedAt: string | null;
  invitedAt: string | null;
  invitationSentAt: string | null;
  invitationCode: InvitationCodeRef | null;
  invitedBy: AdminRef | null;
}

interface InvitationRow {
  id: string;
  code: string;
  note: string;
  maxUses: number;
  useCount: number;
  isActive: boolean;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string | null;
  createdBy: AdminRef | null;
}

interface WaitlistResponse {
  requests: WaitlistRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface InvitationsResponse {
  invitations: InvitationRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface InvitationMutationResponse {
  message?: string;
  invitation?: InvitationRow;
}

const STATUS_FILTERS: Array<{ value: 'all' | WaitlistStatus; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'invited', label: 'Invited' },
  { value: 'closed', label: 'Closed' },
];

const formatDate = (value: string | null): string => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const errMessage = (err: unknown, fallback: string): string => {
  const e = err as { response?: { data?: { error?: string; message?: string } }; message?: string };
  return e?.response?.data?.error || e?.response?.data?.message || e?.message || fallback;
};

const errStatus = (err: unknown): number | undefined => {
  const e = err as { response?: { status?: number } };
  return e?.response?.status;
};

const V2AdminUsers: React.FC = () => {
  const api = useV2Api();

  // ---- Waitlist state ----
  const [waitlist, setWaitlist] = useState<WaitlistRow[]>([]);
  const [waitlistLoading, setWaitlistLoading] = useState(true);
  const [waitlistError, setWaitlistError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | WaitlistStatus>('all');
  // Row-scoped UI state: which row is mid-mutation + per-row inline notices.
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowNotice, setRowNotice] = useState<Record<string, string>>({});

  // ---- Invitation codes state ----
  const [invites, setInvites] = useState<InvitationRow[]>([]);
  const [invitesLoading, setInvitesLoading] = useState(true);
  const [invitesError, setInvitesError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [newCode, setNewCode] = useState<string | null>(null);
  const [inviteBusy, setInviteBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const loadWaitlist = useCallback(async () => {
    setWaitlistLoading(true);
    setWaitlistError(null);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('q', search.trim());
      if (statusFilter !== 'all') params.set('status', statusFilter);
      params.set('limit', '100');
      const data = await api.get<WaitlistResponse>(`/api/admin/users/waitlist?${params.toString()}`);
      setWaitlist(Array.isArray(data?.requests) ? data.requests : []);
    } catch (err) {
      setWaitlistError(errMessage(err, 'Failed to load waitlist.'));
      setWaitlist([]);
    } finally {
      setWaitlistLoading(false);
    }
  }, [api, search, statusFilter]);

  const loadInvites = useCallback(async () => {
    setInvitesLoading(true);
    setInvitesError(null);
    try {
      const data = await api.get<InvitationsResponse>('/api/admin/users/invitations?limit=100');
      setInvites(Array.isArray(data?.invitations) ? data.invitations : []);
    } catch (err) {
      setInvitesError(errMessage(err, 'Failed to load invitation codes.'));
      setInvites([]);
    } finally {
      setInvitesLoading(false);
    }
  }, [api]);

  // Debounce waitlist reloads on search/filter changes so each keystroke
  // doesn't fire a request.
  useEffect(() => {
    const handle = setTimeout(() => { loadWaitlist(); }, 250);
    return () => clearTimeout(handle);
  }, [loadWaitlist]);

  useEffect(() => { loadInvites(); }, [loadInvites]);

  const clearRowNotice = (id: string) => {
    setRowNotice((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const sendInvitation = async (row: WaitlistRow) => {
    setRowBusy(row.id);
    clearRowNotice(row.id);
    try {
      const res = await api.post<{ request?: WaitlistRow }>(
        `/api/admin/users/waitlist/${encodeURIComponent(row.id)}/send-invitation`,
        {},
      );
      if (res?.request) {
        setWaitlist((prev) => prev.map((r) => (r.id === row.id ? res.request as WaitlistRow : r)));
      } else {
        await loadWaitlist();
      }
      // Reflect the freshly-minted code in the codes section.
      await loadInvites();
    } catch (err) {
      if (errStatus(err) === 503) {
        setRowNotice((prev) => ({
          ...prev,
          [row.id]: 'SMTP not configured — generate a code below and share it manually instead.',
        }));
      } else {
        setRowNotice((prev) => ({ ...prev, [row.id]: errMessage(err, 'Failed to send invitation.') }));
      }
    } finally {
      setRowBusy(null);
    }
  };

  const reopen = async (row: WaitlistRow) => {
    setRowBusy(row.id);
    clearRowNotice(row.id);
    try {
      const res = await api.patch<{ request?: WaitlistRow }>(
        `/api/admin/users/waitlist/${encodeURIComponent(row.id)}`,
        { status: 'pending' },
      );
      if (res?.request) {
        setWaitlist((prev) => prev.map((r) => (r.id === row.id ? res.request as WaitlistRow : r)));
      } else {
        await loadWaitlist();
      }
    } catch (err) {
      setRowNotice((prev) => ({ ...prev, [row.id]: errMessage(err, 'Failed to reopen request.') }));
    } finally {
      setRowBusy(null);
    }
  };

  const generateCode = async () => {
    setGenerating(true);
    setGenerateError(null);
    setNewCode(null);
    try {
      const res = await api.post<InvitationMutationResponse>('/api/admin/users/invitations', {});
      const code = res?.invitation?.code || null;
      setNewCode(code);
      await loadInvites();
    } catch (err) {
      setGenerateError(errMessage(err, 'Failed to generate invitation code.'));
    } finally {
      setGenerating(false);
    }
  };

  const revoke = async (invite: InvitationRow) => {
    // eslint-disable-next-line no-alert
    if (typeof window !== 'undefined' && !window.confirm(`Revoke invitation code ${invite.code}? This cannot be undone.`)) {
      return;
    }
    setInviteBusy(invite.id);
    setInvitesError(null);
    try {
      const res = await api.post<InvitationMutationResponse>(
        `/api/admin/users/invitations/${encodeURIComponent(invite.id)}/revoke`,
      );
      if (res?.invitation) {
        setInvites((prev) => prev.map((i) => (i.id === invite.id ? res.invitation as InvitationRow : i)));
      } else {
        await loadInvites();
      }
    } catch (err) {
      setInvitesError(errMessage(err, 'Failed to revoke invitation code.'));
    } finally {
      setInviteBusy(null);
    }
  };

  const copy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      // Clipboard may be unavailable (non-HTTPS / sandbox); user can select manually.
    }
  };

  const statusBadgeClass = (status: string): string => {
    if (status === 'invited') return 'v2-admin-users__badge v2-admin-users__badge--ok';
    if (status === 'closed') return 'v2-admin-users__badge v2-admin-users__badge--muted';
    return 'v2-admin-users__badge v2-admin-users__badge--warn';
  };

  const waitlistEmpty = !waitlistLoading && !waitlistError && waitlist.length === 0;
  const invitesEmpty = !invitesLoading && !invitesError && invites.length === 0;

  const filterTabs = useMemo(() => STATUS_FILTERS, []);

  return (
    <div className="v2-admin-users">
      {/* ---------------- Waitlist ---------------- */}
      <section className="v2-admin-users__section">
        <div className="v2-admin-users__section-head">
          <div>
            <h2 className="v2-admin-users__section-title">Waitlist</h2>
            <p className="v2-admin-users__section-sub">
              Review access requests and send invitation codes.
            </p>
          </div>
          <button
            type="button"
            className="v2-admin-users__btn v2-admin-users__btn--ghost"
            onClick={() => loadWaitlist()}
            disabled={waitlistLoading}
          >
            Refresh
          </button>
        </div>

        <div className="v2-admin-users__controls">
          <input
            type="search"
            className="v2-admin-users__input"
            placeholder="Search email, name, or organization…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="v2-admin-users__tabs" role="tablist" aria-label="Filter by status">
            {filterTabs.map((tab) => (
              <button
                key={tab.value}
                type="button"
                role="tab"
                aria-selected={statusFilter === tab.value}
                className={`v2-admin-users__tab${statusFilter === tab.value ? ' v2-admin-users__tab--active' : ''}`}
                onClick={() => setStatusFilter(tab.value)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {waitlistError && (
          <div className="v2-admin-users__error">{waitlistError}</div>
        )}

        {waitlistLoading ? (
          <div className="v2-admin-users__loading">
            <span className="v2-spinner" /> Loading waitlist…
          </div>
        ) : waitlistEmpty ? (
          <div className="v2-empty">
            <div className="v2-empty__title">No waitlist requests</div>
            <div className="v2-empty__text">
              {search || statusFilter !== 'all'
                ? 'No requests match the current filters.'
                : 'New access requests will appear here.'}
            </div>
          </div>
        ) : (
          <div className="v2-admin-users__table-wrap">
            <table className="v2-admin-users__table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Name</th>
                  <th>Organization</th>
                  <th>Use case</th>
                  <th>Status</th>
                  <th>Requested</th>
                  <th>Invited</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {waitlist.map((row) => {
                  const busy = rowBusy === row.id;
                  const notice = rowNotice[row.id];
                  const isInvited = row.status === 'invited';
                  return (
                    <React.Fragment key={row.id}>
                      <tr>
                        <td className="v2-admin-users__cell-strong">{row.email}</td>
                        <td>{row.name || '—'}</td>
                        <td>{row.organization || '—'}</td>
                        <td className="v2-admin-users__cell-wrap" title={row.note || undefined}>
                          {row.useCase || '—'}
                          {row.note && <span className="v2-admin-users__note">{row.note}</span>}
                        </td>
                        <td>
                          <span className={statusBadgeClass(row.status)}>{row.status}</span>
                        </td>
                        <td className="v2-admin-users__cell-muted">{formatDate(row.createdAt)}</td>
                        <td className="v2-admin-users__cell-muted">
                          {isInvited ? (
                            <>
                              {formatDate(row.invitationSentAt || row.invitedAt)}
                              {row.invitedBy?.username && (
                                <span className="v2-admin-users__note">by {row.invitedBy.username}</span>
                              )}
                              {row.invitationCode?.code && (
                                <span className="v2-admin-users__note">code {row.invitationCode.code}</span>
                              )}
                            </>
                          ) : '—'}
                        </td>
                        <td className="v2-admin-users__actions">
                          {isInvited ? (
                            <button
                              type="button"
                              className="v2-admin-users__btn v2-admin-users__btn--ghost"
                              onClick={() => reopen(row)}
                              disabled={busy}
                            >
                              {busy ? 'Working…' : 'Reopen'}
                            </button>
                          ) : row.status === 'closed' ? (
                            <button
                              type="button"
                              className="v2-admin-users__btn v2-admin-users__btn--ghost"
                              onClick={() => reopen(row)}
                              disabled={busy}
                            >
                              {busy ? 'Working…' : 'Reopen'}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="v2-admin-users__btn v2-admin-users__btn--primary"
                              onClick={() => sendInvitation(row)}
                              disabled={busy}
                            >
                              {busy ? 'Sending…' : 'Send invitation'}
                            </button>
                          )}
                        </td>
                      </tr>
                      {notice && (
                        <tr className="v2-admin-users__notice-row">
                          <td colSpan={8}>
                            <div className="v2-admin-users__notice">{notice}</div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ---------------- Invitation codes ---------------- */}
      <section className="v2-admin-users__section">
        <div className="v2-admin-users__section-head">
          <div>
            <h2 className="v2-admin-users__section-title">Invitation codes</h2>
            <p className="v2-admin-users__section-sub">
              Generate codes to share manually, and revoke codes you no longer want active.
            </p>
          </div>
          <button
            type="button"
            className="v2-admin-users__btn v2-admin-users__btn--primary"
            onClick={generateCode}
            disabled={generating}
          >
            {generating ? 'Generating…' : 'Generate code'}
          </button>
        </div>

        {generateError && <div className="v2-admin-users__error">{generateError}</div>}

        {newCode && (
          <div className="v2-admin-users__newcode">
            <div className="v2-admin-users__newcode-label">New code — copy and share it manually</div>
            <code className="v2-admin-users__newcode-value">{newCode}</code>
            <button
              type="button"
              className="v2-admin-users__btn v2-admin-users__btn--ghost"
              onClick={() => copy(`new:${newCode}`, newCode)}
            >
              {copied === `new:${newCode}` ? 'Copied!' : 'Copy'}
            </button>
            <button
              type="button"
              className="v2-admin-users__btn v2-admin-users__btn--ghost"
              onClick={() => setNewCode(null)}
              aria-label="Dismiss new code"
            >
              Dismiss
            </button>
          </div>
        )}

        {invitesError && <div className="v2-admin-users__error">{invitesError}</div>}

        {invitesLoading ? (
          <div className="v2-admin-users__loading">
            <span className="v2-spinner" /> Loading invitation codes…
          </div>
        ) : invitesEmpty ? (
          <div className="v2-empty">
            <div className="v2-empty__title">No invitation codes</div>
            <div className="v2-empty__text">Generate a code to get started.</div>
          </div>
        ) : (
          <div className="v2-admin-users__table-wrap">
            <table className="v2-admin-users__table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Uses</th>
                  <th>Status</th>
                  <th>Expires</th>
                  <th>Created</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {invites.map((invite) => {
                  const busy = inviteBusy === invite.id;
                  return (
                    <tr key={invite.id}>
                      <td className="v2-admin-users__cell-strong">
                        <code className="v2-admin-users__code">{invite.code}</code>
                        <button
                          type="button"
                          className="v2-admin-users__inline-copy"
                          onClick={() => copy(`code:${invite.id}`, invite.code)}
                        >
                          {copied === `code:${invite.id}` ? 'Copied!' : 'Copy'}
                        </button>
                      </td>
                      <td className="v2-admin-users__cell-muted">
                        {invite.useCount} / {invite.maxUses}
                      </td>
                      <td>
                        <span className={invite.isActive
                          ? 'v2-admin-users__badge v2-admin-users__badge--ok'
                          : 'v2-admin-users__badge v2-admin-users__badge--muted'}
                        >
                          {invite.isActive ? 'active' : 'revoked'}
                        </span>
                      </td>
                      <td className="v2-admin-users__cell-muted">{formatDate(invite.expiresAt)}</td>
                      <td className="v2-admin-users__cell-muted">{formatDate(invite.createdAt)}</td>
                      <td className="v2-admin-users__actions">
                        {invite.isActive && (
                          <button
                            type="button"
                            className="v2-admin-users__btn v2-admin-users__btn--danger"
                            onClick={() => revoke(invite)}
                            disabled={busy}
                          >
                            {busy ? 'Revoking…' : 'Revoke'}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};

export default V2AdminUsers;
