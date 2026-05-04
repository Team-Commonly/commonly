// V2InviteModal — shared invite UI mounted at V2Layout level so both the
// chat header invite icon (V2PodChat) and the inspector "+ Invite" button
// (V2PodInspector) can open the same modal. Two tabs: shareable link
// (people) and an agent install shortcut (browse → install).
import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useV2Api } from '../hooks/useV2Api';

interface V2InviteModalProps {
  open: boolean;
  podId: string;
  podName: string;
  onClose: () => void;
}

const V2InviteModal: React.FC<V2InviteModalProps> = ({ open, podId, podName, onClose }) => {
  const api = useV2Api();
  const navigate = useNavigate();
  const [tab, setTab] = useState<'people' | 'agent'>('people');
  const [url, setUrl] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Reset transient state when the modal closes/reopens for a different
  // pod — otherwise an old invite URL flashes for a beat before regen.
  useEffect(() => {
    if (!open) {
      setTab('people');
      setUrl('');
      setError(null);
      setCopied(false);
      setBusy(false);
    }
  }, [open, podId]);

  const handleGenerate = useCallback(async () => {
    if (!podId) return;
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const data = await api.post<{ token: string }>(`/api/pods/${podId}/invites`, {
        expiresInHours: 24 * 7,
      });
      setUrl(`${window.location.origin}/v2/invite/${data.token}`);
    } catch (err) {
      const e = err as { response?: { data?: { msg?: string } }; message?: string };
      setError(e.response?.data?.msg || e.message || 'Could not generate invite.');
    } finally {
      setBusy(false);
    }
  }, [api, podId]);

  const handleCopy = useCallback(async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable in non-secure contexts — leave the URL
      // selectable so the user can copy manually.
    }
  }, [url]);

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
                Generate a shareable link. Anyone with a Commonly account can use it to join this pod.
              </p>
              {url ? (
                <>
                  <div className="v2-invite-link-row">
                    <input
                      type="text"
                      className="v2-invite-link"
                      readOnly
                      value={url}
                      onFocus={(e) => e.currentTarget.select()}
                    />
                    <button
                      type="button"
                      className="v2-invite-card__cta v2-invite-card__cta--secondary"
                      onClick={handleCopy}
                    >
                      {copied ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                  <p className="v2-modal__hint v2-modal__hint--muted">
                    Link expires in 7 days. Generate a fresh link any time.
                  </p>
                  <button
                    type="button"
                    className="v2-invite-card__cta v2-invite-card__cta--secondary"
                    onClick={handleGenerate}
                    disabled={busy}
                    style={{ marginTop: 8 }}
                  >
                    {busy ? 'Generating…' : 'Generate new link'}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="v2-invite-card__cta"
                  onClick={handleGenerate}
                  disabled={busy}
                >
                  {busy ? 'Generating…' : 'Generate invite link'}
                </button>
              )}
              {error && <div className="v2-modal__error">{error}</div>}
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
