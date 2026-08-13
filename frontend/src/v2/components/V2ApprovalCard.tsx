// ADR-020 D3 — the approval card, first payload-driven message component.
//
// Renders the ApprovalAction's authoritative face from `message.payload`
// (kind 'approval-card'). Action buttons show ONLY for the card's owner
// (payload.ownerUserId — shared state, compared client-side to the viewer;
// never a broadcast per-viewer flag). Click → POST /api/approvals/:id/resolve
// → server rewrites the payload → `messageCardUpdated` patches every client.
// No optimistic update: an approval is exactly the kind of state where the
// server's word is the only honest one (same discipline as reactions).
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { useV2Api } from '../hooks/useV2Api';
import type { V2Message } from '../hooks/useV2PodDetail';

interface V2ApprovalCardProps {
  message: V2Message;
  authorLabel: string;
  time: string | null;
}

// The consent line is derived from the fields the executor actually reads —
// `actionType` + `params` — and never from `summary`.
//
// `summary` is caller-supplied prose whose entire server-side validation is
// empty-reject plus 500-truncate (approvalActionService:151-152, :176).
// Nothing checks that the sentence describes the action, so an agent can send
// actionType 'create_pod' with summary "just tidying up your notes" and the
// human consents to the sentence while the params execute. That gap is live
// today — it is not a BYO-only forecast (sprint-review, fleet review
// 2026-08-13).
//
// The prose stays: it is the agent's reason for asking, and that is worth
// reading. It renders as a pitch beneath the action, never as the headline.
const describeAction = (
  actionType?: string | null,
  params?: Record<string, unknown> | null,
): { key: string; vars: Record<string, string> } | null => {
  if (!actionType) return null;
  const p = params || {};
  if (actionType === 'create_pod') {
    return {
      key: 'approvalCard.action.createPod',
      vars: { name: String(p.name ?? ''), type: String(p.type || 'chat') },
    };
  }
  if (actionType === 'connect_local_agent') {
    return {
      key: 'approvalCard.action.connectLocalAgent',
      vars: { name: String(p.name ?? '') },
    };
  }
  // An actionType we have no phrasing for is still not licence to promote
  // prose back into the action slot. Name it and show the params verbatim:
  // ugly beats wrong on a consent surface, and it degrades safely when the
  // kernel gains an action type before the shell learns its wording.
  return {
    key: 'approvalCard.action.unknown',
    vars: { actionType, params: JSON.stringify(p) },
  };
};

const V2ApprovalCard: React.FC<V2ApprovalCardProps> = ({ message, authorLabel, time }) => {
  const { t } = useTranslation();
  const { currentUser } = useAuth();
  const api = useV2Api();
  const navigate = useNavigate();
  const [deciding, setDeciding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const payload = message.payload || {};
  const status = payload.status || 'flagged';
  const isOwner = !!currentUser?._id && String(currentUser._id) === String(payload.ownerUserId || '');
  // ADR-017:201 — expiry is advisory AGE, not refusal. A flagged card past
  // expiresAt stays decidable; it renders an age warning beside live buttons
  // rather than dead ones. Only an explicitly-transitioned 'expired' status
  // renders the terminal face.
  const aged = status === 'flagged' && !!payload.expiresAt
    && new Date(payload.expiresAt).getTime() < Date.now();
  const execution = payload.executionResult as
    | {
      podId?: string;
      agentJoined?: boolean;
      agentJoinError?: string;
      connectPath?: string;
      alreadyInstalled?: boolean;
    }
    | undefined;
  // connect_local_agent's result carries a connectPath — the seat exists,
  // but the token step is a human-in-browser act on the connect page; the
  // card's job is to hand the user there, never to carry a credential.
  // Payload is DB data: only navigate an in-app /v2/ path, never a value
  // that could steer the click off-origin.
  const rawConnectPath = execution?.connectPath;
  const connectPath = rawConnectPath && rawConnectPath.startsWith('/v2/') ? rawConnectPath : undefined;
  const resultPodId = connectPath ? undefined : execution?.podId;
  // Partial success is its own truth: the pod exists (user owns it) but the
  // agent couldn't join and would 403 on every post — say so, don't say done.
  const agentJoinFailed = execution?.agentJoined === false;
  const action = describeAction(payload.actionType, payload.params);
  const prose = payload.summary || message.content;

  const decide = async (decision: 'approved' | 'declined') => {
    if (deciding || !payload.approvalId) return;
    setDeciding(true);
    setError(null);
    try {
      await api.post(`/api/approvals/${encodeURIComponent(payload.approvalId)}/resolve`, { decision });
      // State lands via messageCardUpdated; nothing to set here.
    } catch (err) {
      const status409 = (err as { response?: { status?: number } })?.response?.status;
      setError(status409 === 410 ? t('approvalCard.errors.expired') : t('approvalCard.errors.failed'));
    } finally {
      setDeciding(false);
    }
  };

  return (
    <div className="v2-msg v2-msg--system v2-msg--card" data-testid="approval-card">
      <div className="v2-approval">
        <div className="v2-approval__head">
          <span className="v2-approval__badge">{t('approvalCard.badge')}</span>
          <span className="v2-approval__agent">{authorLabel}</span>
          {time && <span className="v2-approval__time">{time}</span>}
        </div>
        {action ? (
          <>
            <div className="v2-approval__action" data-testid="approval-action">
              {t(action.key, action.vars)}
            </div>
            {prose && <div className="v2-approval__pitch">{prose}</div>}
          </>
        ) : (
          // Only reachable for a payload with no actionType at all, which the
          // server never mints. Rendering the prose alone beats rendering
          // nothing, and there is no action to misrepresent.
          <div className="v2-approval__summary">{prose}</div>
        )}

        {status === 'flagged' && (
          <>
            {aged && (
              <div className="v2-approval__state v2-approval__state--expired">
                {t('approvalCard.aged')}
              </div>
            )}
            {isOwner ? (
              <div className="v2-approval__actions">
                <button
                  type="button"
                  className="v2-approval__btn v2-approval__btn--approve"
                  disabled={deciding}
                  onClick={() => decide('approved')}
                >
                  {deciding ? t('approvalCard.deciding') : t('approvalCard.approve')}
                </button>
                <button
                  type="button"
                  className="v2-approval__btn v2-approval__btn--decline"
                  disabled={deciding}
                  onClick={() => decide('declined')}
                >
                  {t('approvalCard.decline')}
                </button>
              </div>
            ) : (
              <div className="v2-approval__state">{t('approvalCard.waitingForOwner')}</div>
            )}
          </>
        )}

        {status === 'resolved' && payload.decision === 'approved' && (
          <div className={`v2-approval__state ${payload.executionError || agentJoinFailed ? 'v2-approval__state--attention' : 'v2-approval__state--approved'}`}>
            {payload.executionError
              ? t('approvalCard.approvedButFailed', { error: payload.executionError })
              : agentJoinFailed
                ? t('approvalCard.approvedAgentJoinFailed', { agent: payload.agentName || 'agent' })
                : connectPath
                  ? t('approvalCard.approvedSeatReady')
                  : t('approvalCard.approved')}
            {connectPath && !payload.executionError && (
              <button
                type="button"
                className="v2-approval__result-link"
                onClick={() => navigate(connectPath)}
              >
                {t('approvalCard.openConnect')}
              </button>
            )}
            {resultPodId && !payload.executionError && (
              <button
                type="button"
                className="v2-approval__result-link"
                onClick={() => navigate(`/v2/pods/${resultPodId}`)}
              >
                {t('approvalCard.openResult')}
              </button>
            )}
          </div>
        )}

        {status === 'resolved' && payload.decision === 'declined' && (
          <div className="v2-approval__state v2-approval__state--declined">
            {t('approvalCard.declined')}
          </div>
        )}

        {status === 'expired' && (
          <div className="v2-approval__state v2-approval__state--expired">
            {t('approvalCard.expired')}
          </div>
        )}
        {/* No 'moot' face: its only writer is the delivery-failure branch,
            which fires precisely when no card message exists to render it
            (pod-architect, fleet review 2026-08-13). The model keeps the
            state for audit; the UI declares only reachable faces. */}

        {error && <div className="v2-approval__error" role="alert">{error}</div>}
      </div>
    </div>
  );
};

export default V2ApprovalCard;
