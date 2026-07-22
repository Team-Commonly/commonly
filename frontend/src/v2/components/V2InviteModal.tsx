// V2InviteModal — shared invite UI mounted at V2Layout level so both the
// chat header invite icon (V2PodChat) and the inspector "+ Invite" button
// can open the same modal. Two tabs: shareable links (people) and an agent
// install shortcut (browse → install).
import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useV2Api } from '../hooks/useV2Api';

interface V2InviteModalProps {
  open: boolean;
  podId: string;
  podName: string;
  onClose: () => void;
}

interface ManagedInvite {
  token: string;
  createdBy?: string | { _id?: string; username?: string };
  createdAt: string;
  expiresAt?: string | null;
  maxUses?: number | null;
  uses: number;
}

type ExpiryPreset = 'never' | '24' | '168' | '720';
type MaxUsesPreset = 'unlimited' | '1' | '10' | '25';

const inviteUrlFor = (token: string): string => (
  `${window.location.origin}/v2/invite/${token}`
);

const creatorName = (invite: ManagedInvite): string => (
  typeof invite.createdBy === 'object' && invite.createdBy?.username
    ? invite.createdBy.username
    : 'Pod member'
);

const relativeCreatedAt = (value: string): string => {
  const created = new Date(value).getTime();
  const elapsed = Date.now() - created;
  if (!Number.isFinite(created) || elapsed < 0) return 'Recently';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(value).toLocaleDateString();
};

const expiryLabel = (value?: string | null): string => {
  if (!value) return 'Never expires';
  const expiry = new Date(value);
  if (!Number.isFinite(expiry.getTime())) return 'Expiry unavailable';
  return `Expires ${expiry.toLocaleDateString()}`;
};

const V2InviteModal: React.FC<V2InviteModalProps> = ({ open, podId, podName, onClose }) => {
  const api = useV2Api();
  const navigate = useNavigate();
  const [tab, setTab] = useState<'people' | 'agent'>('people');
  const [url, setUrl] = useState<string>('');
  const [expiry, setExpiry] = useState<ExpiryPreset>('168');
  const [maxUses, setMaxUses] = useState<MaxUsesPreset>('unlimited');
  const [invites, setInvites] = useState<ManagedInvite[]>([]);
  const [busy, setBusy] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [revokingToken, setRevokingToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  const loadInvites = useCallback(async () => {
    if (!podId) return;
    setListLoading(true);
    setListError(null);
    try {
      const data = await api.get<ManagedInvite[]>(`/api/pods/${podId}/invites`);
      setInvites(Array.isArray(data) ? data : []);
    } catch (err) {
      const e = err as { response?: { data?: { msg?: string } }; message?: string };
      setListError(e.response?.data?.msg || e.message || 'Could not load invite links.');
    } finally {
      setListLoading(false);
    }
  }, [api, podId]);

  // Reset transient state when the modal closes or switches pods — otherwise
  // an old invite URL can flash before the next pod's links load.
  useEffect(() => {
    setTab('people');
    setUrl('');
    setExpiry('168');
    setMaxUses('unlimited');
    setError(null);
    setListError(null);
    setCopiedToken(null);
    setBusy(false);
    setRevokingToken(null);
    if (!open) setInvites([]);
  }, [open, podId]);

  useEffect(() => {
    if (!open || !podId) return;
    void loadInvites();
  }, [open, podId, loadInvites]);

  const handleGenerate = useCallback(async () => {
    if (!podId) return;
    setBusy(true);
    setError(null);
    setCopiedToken(null);
    try {
      const expiresInHours = expiry === 'never' ? null : Number(expiry);
      const useLimit = maxUses === 'unlimited' ? null : Number(maxUses);
      const data = await api.post<{ token: string }>(`/api/pods/${podId}/invites`, {
        expiresInHours,
        maxUses: useLimit,
      });
      setUrl(inviteUrlFor(data.token));
      await loadInvites();
    } catch (err) {
      const e = err as { response?: { data?: { msg?: string } }; message?: string };
      setError(e.response?.data?.msg || e.message || 'Could not generate invite.');
    } finally {
      setBusy(false);
    }
  }, [api, expiry, loadInvites, maxUses, podId]);

  const handleCopy = useCallback(async (link: string, token: string) => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopiedToken(token);
      setTimeout(() => setCopiedToken((current) => (current === token ? null : current)), 1500);
    } catch {
      // The generated URL and managed-link inputs stay selectable when the
      // Clipboard API is unavailable, so manual copy remains possible.
    }
  }, []);

  const handleRevoke = useCallback(async (token: string) => {
    setRevokingToken(token);
    setListError(null);
    try {
      await api.del(`/api/invites/${encodeURIComponent(token)}`);
      setInvites((current) => current.filter((invite) => invite.token !== token));
      if (url === inviteUrlFor(token)) setUrl('');
    } catch (err) {
      const e = err as { response?: { data?: { msg?: string } }; message?: string };
      setListError(e.response?.data?.msg || e.message || 'Could not revoke invite.');
    } finally {
      setRevokingToken(null);
    }
  }, [api, url]);

  if (!open) return null;

  return (
    <div
      className="v2-modal__overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Invite to pod"
      onClick={onClose}
    >
      <div className="v2-modal" onClick={(e) => e.stopPropagation()}>
        <div className="v2-modal__head">
          <div className="v2-modal__title">Invite to {podName}</div>
          <button type="button" className="v2-modal__close" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="v2-modal__tabs" role="tablist">
          <button
            type="button"
            role="tab"
            className={`v2-modal__tab${tab === 'people' ? ' v2-modal__tab--active' : ''}`}
            aria-selected={tab === 'people'}
            onClick={() => setTab('people')}
          >
            Invite people
          </button>
          <button
            type="button"
            role="tab"
            className={`v2-modal__tab${tab === 'agent' ? ' v2-modal__tab--active' : ''}`}
            aria-selected={tab === 'agent'}
            onClick={() => setTab('agent')}
          >
            Add agent
          </button>
        </div>
        <div className="v2-modal__body">
          {tab === 'people' && (
            <>
              <p className="v2-modal__hint">
                Create a link anyone with a Commonly account can use to join this pod.
              </p>
              <div className="v2-invite-options">
                <label className="v2-invite-options__field">
                  <span>Expires after</span>
                  <select
                    className="v2-invite-options__select"
                    aria-label="Invite expiry"
                    value={expiry}
                    onChange={(event) => setExpiry(event.target.value as ExpiryPreset)}
                  >
                    <option value="never">Never</option>
                    <option value="24">24 hours</option>
                    <option value="168">7 days</option>
                    <option value="720">30 days</option>
                  </select>
                </label>
                <label className="v2-invite-options__field">
                  <span>Maximum uses</span>
                  <select
                    className="v2-invite-options__select"
                    aria-label="Invite maximum uses"
                    value={maxUses}
                    onChange={(event) => setMaxUses(event.target.value as MaxUsesPreset)}
                  >
                    <option value="unlimited">Unlimited</option>
                    <option value="1">1 use</option>
                    <option value="10">10 uses</option>
                    <option value="25">25 uses</option>
                  </select>
                </label>
              </div>
              <button
                type="button"
                className="v2-invite-card__cta"
                onClick={handleGenerate}
                disabled={busy}
              >
                {busy ? 'Generating…' : 'Generate invite link'}
              </button>
              {url && (
                <>
                  <div className="v2-invite-link-row">
                    <input
                      type="text"
                      className="v2-invite-link"
                      aria-label="New invite link"
                      readOnly
                      value={url}
                      onFocus={(e) => e.currentTarget.select()}
                    />
                    <button
                      type="button"
                      className="v2-invite-card__cta v2-invite-card__cta--secondary"
                      onClick={() => handleCopy(url, 'new')}
                    >
                      {copiedToken === 'new' ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                  <p className="v2-modal__hint v2-modal__hint--muted">
                    The new link also appears under Active links below.
                  </p>
                </>
              )}
              {error && <div className="v2-modal__error">{error}</div>}

              <section className="v2-invite-manage" aria-labelledby="active-invite-links">
                <div className="v2-modal__section-title" id="active-invite-links">Active links</div>
                {listLoading && <div className="v2-invite-manage__empty">Loading links…</div>}
                {!listLoading && invites.length === 0 && !listError && (
                  <div className="v2-invite-manage__empty">No active invite links.</div>
                )}
                {!listLoading && invites.length > 0 && (
                  <div className="v2-invite-manage__list">
                    {invites.map((invite) => {
                      const link = inviteUrlFor(invite.token);
                      const creator = creatorName(invite);
                      return (
                        <div className="v2-invite-manage__item" key={invite.token}>
                          <div className="v2-invite-manage__summary">
                            <strong>{creator}</strong>
                            <span>{relativeCreatedAt(invite.createdAt)}</span>
                          </div>
                          <div className="v2-invite-manage__meta">
                            <span>{invite.maxUses == null ? `${invite.uses} uses · unlimited` : `${invite.uses} of ${invite.maxUses} uses`}</span>
                            <span>{expiryLabel(invite.expiresAt)}</span>
                          </div>
                          <input
                            type="text"
                            className="v2-invite-manage__url"
                            aria-label={`Invite link created by ${creator}`}
                            readOnly
                            value={link}
                            onFocus={(event) => event.currentTarget.select()}
                          />
                          <div className="v2-invite-manage__actions">
                            <button
                              type="button"
                              className="v2-invite-manage__action"
                              onClick={() => handleCopy(link, invite.token)}
                            >
                              {copiedToken === invite.token ? 'Copied!' : 'Copy'}
                            </button>
                            <button
                              type="button"
                              className="v2-invite-manage__action v2-invite-manage__action--danger"
                              onClick={() => handleRevoke(invite.token)}
                              disabled={revokingToken === invite.token}
                              aria-label={`Revoke invite created by ${creator}`}
                            >
                              {revokingToken === invite.token ? 'Revoking…' : 'Revoke'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {listError && <div className="v2-modal__error">{listError}</div>}
              </section>
            </>
          )}
          {tab === 'agent' && (
            <>
              <p className="v2-modal__hint">
                Pick an agent from the catalog to install into this pod.
              </p>
              <button
                type="button"
                className="v2-invite-card__cta"
                onClick={() => {
                  onClose();
                  navigate(`/v2/agents/browse?podId=${podId}`);
                }}
              >
                Browse agents →
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default V2InviteModal;
