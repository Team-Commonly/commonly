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
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
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

const STATUS_FILTER_VALUES: Array<'all' | WaitlistStatus> = ['all', 'pending', 'invited', 'closed'];

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

type RegisteredUser = {
  id: string;
  username: string;
  email: string;
  role: string;
  verified: boolean;
  banned: boolean;
  banReason?: string | null;
  createdAt?: string;
};

// "joined 15d · 3 pods · 42 msgs" — compact per-user lifecycle summary
// (GH#662). Counts come from /api/admin/analytics/lifecycle as a separate,
// failure-isolated fetch so moderation keeps working if PostgreSQL is down.
type LifecycleStats = Record<string, { pods: number; messages: number }>;

const lifecycleLabel = (
  u: RegisteredUser,
  stats: LifecycleStats | null,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string => {
  const joined = u.createdAt
    ? t('adminUsers.lifecycle.joinedDays', {
        count: Math.max(0, Math.floor((Date.now() - new Date(u.createdAt).getTime()) / (24 * 60 * 60 * 1000))),
      })
    : t('adminUsers.lifecycle.joinedUnknown');
  const s = stats?.[u.id];
  if (!s) return joined;
  const podsLabel = t('adminUsers.lifecycle.pods', { count: s.pods });
  const messagesLabel = t('adminUsers.lifecycle.messages', { count: s.messages });
  return `${joined} · ${podsLabel} · ${messagesLabel}`;
};

const V2AdminUsers: React.FC = () => {
  const api = useV2Api();
  const { t } = useTranslation();

  // ---- Registered users state (moderation: ban / remove) ----
  const [users, setUsers] = useState<RegisteredUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [userSearch, setUserSearch] = useState('');
  const [userBusy, setUserBusy] = useState<string | null>(null);
  const [lifecycle, setLifecycle] = useState<LifecycleStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<{ users?: LifecycleStats }>('/api/admin/analytics/lifecycle');
        if (!cancelled) setLifecycle(data.users || {});
      } catch {
        // Column degrades to "joined Nd" — moderation stays fully usable.
      }
    })();
    return () => { cancelled = true; };
  }, [api]);

  const fetchUsers = useCallback(async (q: string) => {
    setUsersLoading(true);
    setUsersError(null);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set('q', q.trim());
      const data = await api.get<{ users?: RegisteredUser[] }>(`/api/admin/users?${params.toString()}`);
      setUsers(data.users || []);
    } catch (err: unknown) {
      setUsersError(errMessage(err, t('adminUsers.errors.loadUsers')));
    } finally {
      setUsersLoading(false);
    }
  }, [api, t]);

  useEffect(() => {
    const handle = setTimeout(() => { fetchUsers(userSearch); }, 250);
    return () => clearTimeout(handle);
  }, [fetchUsers, userSearch]);

  const handleBanToggle = async (u: RegisteredUser) => {
    const banning = !u.banned;
    // eslint-disable-next-line no-alert
    const reason = banning ? window.prompt(t('adminUsers.prompts.ban', { username: u.username }), '') : null;
    if (banning && reason === null) return; // prompt cancelled
    setUserBusy(u.id);
    try {
      await api.patch(`/api/admin/users/${encodeURIComponent(u.id)}/ban`, {
        banned: banning,
        ...(banning && reason ? { reason } : {}),
      });
      await fetchUsers(userSearch);
    } catch (err: unknown) {
      setUsersError(errMessage(err, t('adminUsers.errors.updateBan')));
    } finally {
      setUserBusy(null);
    }
  };

  const handleDeleteUser = async (u: RegisteredUser) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(t('adminUsers.prompts.deleteUser', { username: u.username, email: u.email }))) return;
    setUserBusy(u.id);
    try {
      await api.del(`/api/admin/users/${encodeURIComponent(u.id)}`);
      await fetchUsers(userSearch);
    } catch (err: unknown) {
      setUsersError(errMessage(err, t('adminUsers.errors.deleteUser')));
    } finally {
      setUserBusy(null);
    }
  };

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
      setWaitlistError(errMessage(err, t('adminUsers.errors.loadWaitlist')));
      setWaitlist([]);
    } finally {
      setWaitlistLoading(false);
    }
  }, [api, search, statusFilter, t]);

  const loadInvites = useCallback(async () => {
    setInvitesLoading(true);
    setInvitesError(null);
    try {
      const data = await api.get<InvitationsResponse>('/api/admin/users/invitations?limit=100');
      setInvites(Array.isArray(data?.invitations) ? data.invitations : []);
    } catch (err) {
      setInvitesError(errMessage(err, t('adminUsers.errors.loadInvites')));
      setInvites([]);
    } finally {
      setInvitesLoading(false);
    }
  }, [api, t]);

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
          [row.id]: t('adminUsers.notices.smtpNotConfigured'),
        }));
      } else {
        setRowNotice((prev) => ({ ...prev, [row.id]: errMessage(err, t('adminUsers.errors.sendInvitation')) }));
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
      setRowNotice((prev) => ({ ...prev, [row.id]: errMessage(err, t('adminUsers.errors.reopenRequest')) }));
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
      setGenerateError(errMessage(err, t('adminUsers.errors.generateCode')));
    } finally {
      setGenerating(false);
    }
  };

  const revoke = async (invite: InvitationRow) => {
    // eslint-disable-next-line no-alert
    if (typeof window !== 'undefined' && !window.confirm(t('adminUsers.prompts.revokeCode', { code: invite.code }))) {
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
      setInvitesError(errMessage(err, t('adminUsers.errors.revokeCode')));
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

  const waitlistStatusLabel = (status: string): string => {
    if (status === 'pending' || status === 'invited' || status === 'closed') {
      return t(`adminUsers.waitlist.status.${status}`);
    }
    return status;
  };

  const waitlistEmpty = !waitlistLoading && !waitlistError && waitlist.length === 0;
  const invitesEmpty = !invitesLoading && !invitesError && invites.length === 0;

  const filterTabs = useMemo(
    () => STATUS_FILTER_VALUES.map((value) => ({ value, label: t(`adminUsers.statusFilters.${value}`) })),
    [t],
  );

  return (
    <div className="v2-admin-users">
      {/* ---------------- Registered users ---------------- */}
      <section className="v2-admin-users__section">
        <div className="v2-admin-users__section-head">
          <div>
            <h2 className="v2-admin-users__section-title">{t('adminUsers.registered.title')}</h2>
            <p className="v2-admin-users__section-sub">
              {t('adminUsers.registered.subtitle')}{' '}
              <Link to="/v2/admin/analytics" className="v2-admin-analytics__crosslink">{t('adminUsers.registered.analyticsLink')}</Link>
            </p>
          </div>
          <input
            className="v2-admin-users__search"
            type="search"
            placeholder={t('adminUsers.registered.searchPlaceholder')}
            value={userSearch}
            onChange={(e) => setUserSearch(e.target.value)}
          />
        </div>
        {usersError && <div className="v2-admin-users__error" role="alert">{usersError}</div>}
        {usersLoading ? (
          <div className="v2-admin-users__empty">{t('adminUsers.registered.loading')}</div>
        ) : users.length === 0 ? (
          <div className="v2-admin-users__empty">{t('adminUsers.registered.noMatch')}</div>
        ) : (
          <div className="v2-admin-users__table-wrap">
            <table className="v2-admin-users__table">
              <thead>
                <tr>
                  <th>{t('adminUsers.registered.columns.username')}</th>
                  <th>{t('adminUsers.registered.columns.email')}</th>
                  <th>{t('adminUsers.registered.columns.role')}</th>
                  <th>{t('adminUsers.registered.columns.status')}</th>
                  <th>{t('adminUsers.registered.columns.lifecycle')}</th>
                  <th aria-label={t('adminUsers.columns.actions')} />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const busy = userBusy === u.id;
                  return (
                    <tr key={u.id}>
                      <td>{u.username}</td>
                      <td>{u.email}</td>
                      <td>{u.role}</td>
                      <td>
                        {u.banned
                          ? <span className="v2-admin-users__badge v2-admin-users__badge--banned" title={u.banReason || undefined}>{t('adminUsers.registered.userStatus.banned')}</span>
                          : (u.verified ? t('adminUsers.registered.userStatus.active') : t('adminUsers.registered.userStatus.unverified'))}
                      </td>
                      <td className="v2-admin-users__cell-muted" title={u.createdAt ? new Date(u.createdAt).toLocaleDateString() : undefined}>
                        {lifecycleLabel(u, lifecycle, t)}
                      </td>
                      <td className="v2-admin-users__row-actions">
                        <button
                          type="button"
                          className="v2-admin-users__btn"
                          disabled={busy || u.role === 'admin'}
                          title={u.role === 'admin' ? t('adminUsers.registered.demoteAdminFirst') : undefined}
                          onClick={() => handleBanToggle(u)}
                        >
                          {busy ? '…' : (u.banned ? t('adminUsers.actions.unban') : t('adminUsers.actions.ban'))}
                        </button>
                        <button
                          type="button"
                          className="v2-admin-users__btn v2-admin-users__btn--danger"
                          disabled={busy || u.role === 'admin'}
                          title={u.role === 'admin' ? t('adminUsers.registered.demoteAdminFirst') : undefined}
                          onClick={() => handleDeleteUser(u)}
                        >
                          {t('adminUsers.actions.delete')}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ---------------- Waitlist ---------------- */}
      <section className="v2-admin-users__section">
        <div className="v2-admin-users__section-head">
          <div>
            <h2 className="v2-admin-users__section-title">{t('adminUsers.waitlist.title')}</h2>
            <p className="v2-admin-users__section-sub">
              {t('adminUsers.waitlist.subtitle')}
            </p>
          </div>
          <button
            type="button"
            className="v2-admin-users__btn v2-admin-users__btn--ghost"
            onClick={() => loadWaitlist()}
            disabled={waitlistLoading}
          >
            {t('adminUsers.actions.refresh')}
          </button>
        </div>

        <div className="v2-admin-users__controls">
          <input
            type="search"
            className="v2-admin-users__input"
            placeholder={t('adminUsers.waitlist.searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="v2-admin-users__tabs" role="tablist" aria-label={t('adminUsers.waitlist.filterByStatus')}>
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
            <span className="v2-spinner" /> {t('adminUsers.waitlist.loading')}
          </div>
        ) : waitlistEmpty ? (
          <div className="v2-empty">
            <div className="v2-empty__title">{t('adminUsers.waitlist.emptyTitle')}</div>
            <div className="v2-empty__text">
              {search || statusFilter !== 'all'
                ? t('adminUsers.waitlist.emptyFiltered')
                : t('adminUsers.waitlist.emptyDefault')}
            </div>
          </div>
        ) : (
          <div className="v2-admin-users__table-wrap">
            <table className="v2-admin-users__table">
              <thead>
                <tr>
                  <th>{t('adminUsers.waitlist.columns.email')}</th>
                  <th>{t('adminUsers.waitlist.columns.name')}</th>
                  <th>{t('adminUsers.waitlist.columns.organization')}</th>
                  <th>{t('adminUsers.waitlist.columns.useCase')}</th>
                  <th>{t('adminUsers.waitlist.columns.status')}</th>
                  <th>{t('adminUsers.waitlist.columns.requested')}</th>
                  <th>{t('adminUsers.waitlist.columns.invited')}</th>
                  <th aria-label={t('adminUsers.columns.actions')} />
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
                          <span className={statusBadgeClass(row.status)}>{waitlistStatusLabel(row.status)}</span>
                        </td>
                        <td className="v2-admin-users__cell-muted">{formatDate(row.createdAt)}</td>
                        <td className="v2-admin-users__cell-muted">
                          {isInvited ? (
                            <>
                              {formatDate(row.invitationSentAt || row.invitedAt)}
                              {row.invitedBy?.username && (
                                <span className="v2-admin-users__note">{t('adminUsers.waitlist.invitedBy', { username: row.invitedBy.username })}</span>
                              )}
                              {row.invitationCode?.code && (
                                <span className="v2-admin-users__note">{t('adminUsers.waitlist.invitedCode', { code: row.invitationCode.code })}</span>
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
                              {busy ? t('adminUsers.actions.working') : t('adminUsers.actions.reopen')}
                            </button>
                          ) : row.status === 'closed' ? (
                            <button
                              type="button"
                              className="v2-admin-users__btn v2-admin-users__btn--ghost"
                              onClick={() => reopen(row)}
                              disabled={busy}
                            >
                              {busy ? t('adminUsers.actions.working') : t('adminUsers.actions.reopen')}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="v2-admin-users__btn v2-admin-users__btn--primary"
                              onClick={() => sendInvitation(row)}
                              disabled={busy}
                            >
                              {busy ? t('adminUsers.actions.sending') : t('adminUsers.actions.sendInvitation')}
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
            <h2 className="v2-admin-users__section-title">{t('adminUsers.invites.title')}</h2>
            <p className="v2-admin-users__section-sub">
              {t('adminUsers.invites.subtitle')}
            </p>
          </div>
          <button
            type="button"
            className="v2-admin-users__btn v2-admin-users__btn--primary"
            onClick={generateCode}
            disabled={generating}
          >
            {generating ? t('adminUsers.actions.generating') : t('adminUsers.actions.generateCode')}
          </button>
        </div>

        {generateError && <div className="v2-admin-users__error">{generateError}</div>}

        {newCode && (
          <div className="v2-admin-users__newcode">
            <div className="v2-admin-users__newcode-label">{t('adminUsers.invites.newCodeLabel')}</div>
            <code className="v2-admin-users__newcode-value">{newCode}</code>
            <button
              type="button"
              className="v2-admin-users__btn v2-admin-users__btn--ghost"
              onClick={() => copy(`new:${newCode}`, newCode)}
            >
              {copied === `new:${newCode}` ? t('adminUsers.actions.copied') : t('adminUsers.actions.copy')}
            </button>
            <button
              type="button"
              className="v2-admin-users__btn v2-admin-users__btn--ghost"
              onClick={() => setNewCode(null)}
              aria-label={t('adminUsers.invites.dismissNewCode')}
            >
              {t('adminUsers.actions.dismiss')}
            </button>
          </div>
        )}

        {invitesError && <div className="v2-admin-users__error">{invitesError}</div>}

        {invitesLoading ? (
          <div className="v2-admin-users__loading">
            <span className="v2-spinner" /> {t('adminUsers.invites.loading')}
          </div>
        ) : invitesEmpty ? (
          <div className="v2-empty">
            <div className="v2-empty__title">{t('adminUsers.invites.emptyTitle')}</div>
            <div className="v2-empty__text">{t('adminUsers.invites.emptyText')}</div>
          </div>
        ) : (
          <div className="v2-admin-users__table-wrap">
            <table className="v2-admin-users__table">
              <thead>
                <tr>
                  <th>{t('adminUsers.invites.columns.code')}</th>
                  <th>{t('adminUsers.invites.columns.uses')}</th>
                  <th>{t('adminUsers.invites.columns.status')}</th>
                  <th>{t('adminUsers.invites.columns.expires')}</th>
                  <th>{t('adminUsers.invites.columns.created')}</th>
                  <th aria-label={t('adminUsers.columns.actions')} />
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
                          {copied === `code:${invite.id}` ? t('adminUsers.actions.copied') : t('adminUsers.actions.copy')}
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
                          {invite.isActive ? t('adminUsers.invites.codeStatus.active') : t('adminUsers.invites.codeStatus.revoked')}
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
                            {busy ? t('adminUsers.actions.revoking') : t('adminUsers.actions.revoke')}
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
