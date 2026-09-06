// V2InviteModal — shared invite UI mounted at V2Layout level so both the
// thread starter invite action (V2Thread) and the inspector "+ Invite" button
// can open the same modal. Two tabs: shareable links (people) and an agent
// install shortcut (browse → install).
import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useV2Api } from '../hooks/useV2Api';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

interface V2InviteModalProps {
  open: boolean;
  podId: string;
  podName: string;
  initialTab?: V2InviteTab;
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
export type V2InviteTab = 'people' | 'agent';
const CLOSE_MARK = '×';

const inviteUrlFor = (token: string): string => (
  `${window.location.origin}/v2/invite/${token}`
);

const creatorName = (invite: ManagedInvite, t: TFunction): string => (
  typeof invite.createdBy === 'object' && invite.createdBy?.username
    ? invite.createdBy.username
    : t('inviteModal.podMember')
);

const relativeCreatedAt = (value: string, t: TFunction, locale: string): string => {
  const created = new Date(value).getTime();
  const elapsed = Date.now() - created;
  if (!Number.isFinite(created) || elapsed < 0) return t('inviteModal.time.recently');
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return t('inviteModal.time.justNow');
  const format = (count: number) => new Intl.NumberFormat(locale).format(count);
  if (minutes < 60) return t('inviteModal.time.minutesAgo', { count: minutes, formattedCount: format(minutes) });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('inviteModal.time.hoursAgo', { count: hours, formattedCount: format(hours) });
  const days = Math.floor(hours / 24);
  if (days < 7) return t('inviteModal.time.daysAgo', { count: days, formattedCount: format(days) });
  return new Date(value).toLocaleDateString(locale);
};

const expiryLabel = (value: string | null | undefined, t: TFunction, locale: string): string => {
  if (!value) return t('inviteModal.expiry.neverExpires');
  const expiry = new Date(value);
  if (!Number.isFinite(expiry.getTime())) return t('inviteModal.expiry.unavailable');
  return t('inviteModal.expiry.expiresOn', { date: expiry.toLocaleDateString(locale) });
};

const V2InviteModal: React.FC<V2InviteModalProps> = ({
  open, podId, podName, initialTab = 'people', onClose,
}) => {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language || 'en';
  const numberFormatter = new Intl.NumberFormat(locale);
  const api = useV2Api();
  const navigate = useNavigate();
  const [tab, setTab] = useState<V2InviteTab>(initialTab);
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
      setListError(e.response?.data?.msg || e.message || t('inviteModal.errors.loadFailed'));
    } finally {
      setListLoading(false);
    }
  }, [api, podId, t]);

  // Reset transient state when the modal closes or switches pods — otherwise
  // an old invite URL can flash before the next pod's links load.
  useEffect(() => {
    setTab(initialTab);
    setUrl('');
    setExpiry('168');
    setMaxUses('unlimited');
    setError(null);
    setListError(null);
    setCopiedToken(null);
    setBusy(false);
    setRevokingToken(null);
    if (!open) setInvites([]);
  }, [open, podId, initialTab]);

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
      setError(e.response?.data?.msg || e.message || t('inviteModal.errors.generateFailed'));
    } finally {
      setBusy(false);
    }
  }, [api, expiry, loadInvites, maxUses, podId, t]);

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
      setListError(e.response?.data?.msg || e.message || t('inviteModal.errors.revokeFailed'));
    } finally {
      setRevokingToken(null);
    }
  }, [api, t, url]);

  if (!open) return null;

  return (
    <div
      className="v2-modal__overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t('inviteModal.dialogLabel')}
      onClick={onClose}
    >
      <div className="v2-modal" onClick={(e) => e.stopPropagation()}>
        <div className="v2-modal__head">
          <div className="v2-modal__title">{t('inviteModal.title', { podName })}</div>
          <button type="button" className="v2-modal__close" aria-label={t('common.close')} onClick={onClose}>{CLOSE_MARK}</button>
        </div>
        <div className="v2-modal__tabs" role="tablist">
          <button
            type="button"
            role="tab"
            className={`v2-modal__tab${tab === 'people' ? ' v2-modal__tab--active' : ''}`}
            aria-selected={tab === 'people'}
            onClick={() => setTab('people')}
          >
            {t('inviteModal.tabs.people')}
          </button>
          <button
            type="button"
            role="tab"
            className={`v2-modal__tab${tab === 'agent' ? ' v2-modal__tab--active' : ''}`}
            aria-selected={tab === 'agent'}
            onClick={() => setTab('agent')}
          >
            {t('inviteModal.tabs.agent')}
          </button>
        </div>
        <div className="v2-modal__body">
          {tab === 'people' && (
            <>
              <p className="v2-modal__hint">
                {t('inviteModal.peopleHint')}
              </p>
              <div className="v2-invite-options">
                <label className="v2-invite-options__field">
                  <span>{t('inviteModal.options.expiresAfter')}</span>
                  <select
                    className="v2-invite-options__select"
                    aria-label={t('inviteModal.options.expiryLabel')}
                    value={expiry}
                    onChange={(event) => setExpiry(event.target.value as ExpiryPreset)}
                  >
                    <option value="never">{t('inviteModal.options.never')}</option>
                    <option value="24">{t('inviteModal.options.hours24')}</option>
                    <option value="168">{t('inviteModal.options.days7')}</option>
                    <option value="720">{t('inviteModal.options.days30')}</option>
                  </select>
                </label>
                <label className="v2-invite-options__field">
                  <span>{t('inviteModal.options.maximumUses')}</span>
                  <select
                    className="v2-invite-options__select"
                    aria-label={t('inviteModal.options.maximumUsesLabel')}
                    value={maxUses}
                    onChange={(event) => setMaxUses(event.target.value as MaxUsesPreset)}
                  >
                    <option value="unlimited">{t('inviteModal.options.unlimited')}</option>
                    <option value="1">{t('inviteModal.options.uses', { count: 1, formattedCount: numberFormatter.format(1) })}</option>
                    <option value="10">{t('inviteModal.options.uses', { count: 10, formattedCount: numberFormatter.format(10) })}</option>
                    <option value="25">{t('inviteModal.options.uses', { count: 25, formattedCount: numberFormatter.format(25) })}</option>
                  </select>
                </label>
              </div>
              <button
                type="button"
                className="v2-invite-card__cta"
                onClick={handleGenerate}
                disabled={busy}
              >
                {busy ? t('inviteModal.generating') : t('inviteModal.generate')}
              </button>
              {url && (
                <>
                  <div className="v2-invite-link-row">
                    <input
                      type="text"
                      className="v2-invite-link"
                      aria-label={t('inviteModal.newLinkLabel')}
                      readOnly
                      value={url}
                      onFocus={(e) => e.currentTarget.select()}
                    />
                    <button
                      type="button"
                      className="v2-invite-card__cta v2-invite-card__cta--secondary"
                      onClick={() => handleCopy(url, 'new')}
                    >
                      {copiedToken === 'new' ? t('common.copied') : t('common.copy')}
                    </button>
                  </div>
                  <p className="v2-modal__hint v2-modal__hint--muted">
                    {t('inviteModal.newLinkHint')}
                  </p>
                </>
              )}
              {error && <div className="v2-modal__error">{error}</div>}

              <section className="v2-invite-manage" aria-labelledby="active-invite-links">
                <div className="v2-modal__section-title" id="active-invite-links">{t('inviteModal.activeLinks')}</div>
                {listLoading && <div className="v2-invite-manage__empty">{t('inviteModal.loadingLinks')}</div>}
                {!listLoading && invites.length === 0 && !listError && (
                  <div className="v2-invite-manage__empty">{t('inviteModal.noActiveLinks')}</div>
                )}
                {!listLoading && invites.length > 0 && (
                  <div className="v2-invite-manage__list">
                    {invites.map((invite) => {
                      const link = inviteUrlFor(invite.token);
                      const creator = creatorName(invite, t);
                      return (
                        <div className="v2-invite-manage__item" key={invite.token}>
                          <div className="v2-invite-manage__summary">
                            <strong>{creator}</strong>
                            <span>{relativeCreatedAt(invite.createdAt, t, locale)}</span>
                          </div>
                          <div className="v2-invite-manage__meta">
                            <span>{invite.maxUses == null
                              ? t('inviteModal.usage.unlimited', {
                                count: invite.uses,
                                formattedCount: numberFormatter.format(invite.uses),
                              })
                              : t('inviteModal.usage.limited', {
                                uses: numberFormatter.format(invite.uses),
                                maxUses: numberFormatter.format(invite.maxUses),
                              })}</span>
                            <span>{expiryLabel(invite.expiresAt, t, locale)}</span>
                          </div>
                          <input
                            type="text"
                            className="v2-invite-manage__url"
                            aria-label={t('inviteModal.createdByLabel', { creator })}
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
                              {copiedToken === invite.token ? t('common.copied') : t('common.copy')}
                            </button>
                            <button
                              type="button"
                              className="v2-invite-manage__action v2-invite-manage__action--danger"
                              onClick={() => handleRevoke(invite.token)}
                              disabled={revokingToken === invite.token}
                              aria-label={t('inviteModal.revokeLabel', { creator })}
                            >
                              {revokingToken === invite.token ? t('inviteModal.revoking') : t('inviteModal.revoke')}
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
              {/* Note `?pod=` — V2AgentBYO reads `pod`, not `podId`. */}
              <p className="v2-modal__hint">
                {t('inviteModal.agentHint')}
              </p>
              <button
                type="button"
                className="v2-invite-card__cta"
                onClick={() => {
                  onClose();
                  navigate(`/v2/agents/byo?pod=${podId}`);
                }}
              >
                {t('inviteModal.connectOwnAgent')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default V2InviteModal;
