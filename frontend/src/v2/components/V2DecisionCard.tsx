import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useV2Api } from '../hooks/useV2Api';
import { notifyAttentionChanged } from '../hooks/useV2PodAttention';
import { renderPlainWithMentions } from './V2MentionChip';

export interface V2DecisionOption {
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface V2DecisionAllowedValue {
  value: string;
  reasonRequired?: boolean;
}

/** ADR-037: the hand-back record a card decides, as the shell shows it. */
export interface V2HandBackView {
  status: string;
  stage: 'plan' | 'result';
  asked: { text: string; provenance: 'message' | 'task' | 'owner'; requesterName?: string };
  plan?: string;
  changed?: Array<{ kind: string; ref: string; note?: string }> | null;
  checked?: Array<{ what: string; how: string }> | null;
  unverified?: Array<{ what: string; why?: string }> | null;
  nextAgent?: string;
}

export interface V2DecisionCardData {
  id: string;
  title: string;
  detail?: string;
  actorName?: string;
  options: V2DecisionOption[];
  /** Server-set (ADR-037 §2): only these values rule the card. */
  allowedValues?: V2DecisionAllowedValue[];
  handBack?: V2HandBackView;
}

export interface V2DecisionRuling {
  value: string;
  reason?: string;
  /** The ruler's handle: the stable key, never shown when a name is known. */
  by?: string;
  /** The ruler's display name, which people read (F645). */
  byName?: string;
  at?: string;
  messageId?: string;
}

const PROVENANCE_KEY = {
  message: 'activity.decision.handBack.requesterMessage',
  task: 'activity.decision.handBack.requesterTask',
  owner: 'activity.decision.handBack.requesterOwner',
} as const;

const isWebLink = (ref: string): boolean => /^https?:\/\//i.test(ref);

const HandBackFields: React.FC<{ handBack: V2HandBackView }> = ({ handBack }) => {
  const { t } = useTranslation();
  const { asked } = handBack;
  return (
    <div className="v2-decision-card__handback">
      <p className="v2-decision-card__handback-label">{t('activity.decision.handBack.asked')}</p>
      <p>{asked.text}</p>
      <p className="v2-decision-card__handback-provenance">
        {t(PROVENANCE_KEY[asked.provenance] || PROVENANCE_KEY.owner, { name: asked.requesterName || '?' })}
      </p>
      {handBack.plan && (
        <>
          <p className="v2-decision-card__handback-label">{t('activity.decision.handBack.plan')}</p>
          <p>{handBack.plan}</p>
        </>
      )}
      {handBack.stage === 'result' && (
        <>
          <p className="v2-decision-card__handback-label">{t('activity.decision.handBack.changed')}</p>
          <ul>
            {(handBack.changed || []).map((item) => (
              <li key={`${item.kind}:${item.ref}`}>
                {item.kind}: {isWebLink(item.ref)
                  ? <a href={item.ref} target="_blank" rel="noopener noreferrer">{item.ref}</a>
                  : item.ref}
                {item.note ? ` (${item.note})` : ''}
              </li>
            ))}
          </ul>
          <p className="v2-decision-card__handback-label">{t('activity.decision.handBack.checked')}</p>
          <ul>
            {(handBack.checked || []).map((item) => <li key={item.what}>{item.what}: {item.how}</li>)}
          </ul>
          <p className="v2-decision-card__handback-label">{t('activity.decision.handBack.unverified')}</p>
          {(handBack.unverified || []).length ? (
            <ul>
              {(handBack.unverified || []).map((item) => (
                <li key={item.what}>{item.what}{item.why ? `: ${item.why}` : ''}</li>
              ))}
            </ul>
          ) : <p>{t('activity.decision.handBack.nothingUnverified')}</p>}
        </>
      )}
      {handBack.nextAgent && (
        <p className="v2-decision-card__handback-provenance">{t('activity.decision.handBack.next', { agent: handBack.nextAgent })}</p>
      )}
    </div>
  );
};

interface V2DecisionCardProps {
  decision: V2DecisionCardData;
  onRuled?: (decisionId: string, ruling: V2DecisionRuling) => void;
}

/**
 * The in-thread face of an agent DecisionRequest. The decision is durable
 * server state: a successful choice settles from the response, and a 409
 * shows the standing ruling rather than inviting a second choice.
 */
const V2DecisionCard: React.FC<V2DecisionCardProps> = ({ decision, onRuled }) => {
  const { t } = useTranslation();
  const api = useV2Api();
  const [ruling, setRuling] = useState<V2DecisionRuling | null>(null);
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherValue, setOtherValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const allowed = decision.allowedValues?.length ? decision.allowedValues : null;
  const reasonFor = (value: string): boolean => Boolean(allowed?.some((item) => (
    item.reasonRequired && item.value.toLowerCase() === value.trim().toLowerCase()
  )));
  const asksReason = Boolean(allowed?.some((item) => item.reasonRequired));
  const otherInputRef = useRef<HTMLInputElement | null>(null);
  const otherSubmitRef = useRef<HTMLButtonElement | null>(null);
  const otherSubmissionRef = useRef(false);

  useEffect(() => {
    if (!error || !otherOpen || !otherSubmissionRef.current) return undefined;
    const frame = globalThis.window.requestAnimationFrame(() => {
      const active = document.activeElement;
      // A disabled submit button can blur to body while the request settles.
      // Restore the custom-answer field in that case, but respect a reader
      // who deliberately moved to another control during the failed request.
      if (active === document.body || active === otherInputRef.current || active === otherSubmitRef.current) {
        otherInputRef.current?.focus({ preventScroll: true });
      }
    });
    return () => globalThis.window.cancelAnimationFrame(frame);
  }, [error, otherOpen]);

  const choose = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || saving || ruling) return;
    const why = reason.trim();
    if (reasonFor(trimmed) && !why) {
      setError(t('activity.decision.reasonRequired'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await api.post<{
        decision?: { ruling?: V2DecisionRuling | null };
      }>(`/api/activity/decisions/${encodeURIComponent(decision.id)}/choose`, why && asksReason
        ? { value: trimmed, reason: why }
        : { value: trimmed });
      const settled = response?.decision?.ruling;
      const settledReason = settled?.reason || (asksReason ? why : '');
      const next = {
        value: settled?.value || trimmed,
        ...(settledReason ? { reason: settledReason } : {}),
        ...(settled?.by ? { by: settled.by } : {}),
        ...(settled?.byName ? { byName: settled.byName } : {}),
        ...(settled?.at ? { at: settled.at } : {}),
        ...(settled?.messageId ? { messageId: settled.messageId } : {}),
      };
      setRuling(next);
      onRuled?.(decision.id, next);
      notifyAttentionChanged();
    } catch (caught) {
      const response = (caught as {
        response?: { status?: number; data?: { code?: string; decision?: { ruling?: V2DecisionRuling } } };
      }).response;
      const code = response?.data?.code;
      const standing = response?.data?.decision?.ruling;
      if (response?.status === 409 && standing?.value) {
        const next = {
          value: standing.value,
          ...(standing.by ? { by: standing.by } : {}),
          ...(standing.byName ? { byName: standing.byName } : {}),
          ...(standing.at ? { at: standing.at } : {}),
          ...(standing.messageId ? { messageId: standing.messageId } : {}),
        };
        setRuling(next);
        onRuled?.(decision.id, next);
        notifyAttentionChanged();
      } else if (code === 'decision_closed') {
        setError(t('activity.decision.closed'));
      } else if (code === 'subject_stage_mismatch' || code === 'subject_check_missing') {
        setError(t('activity.decision.movedOn'));
      } else if (code === 'reason_required') {
        setError(t('activity.decision.reasonRequired'));
      } else {
        setError(t('activity.decision.actionFailed'));
      }
    } finally {
      setSaving(false);
    }
  };

  // Option order is part of the asking agent's fork. The artboard gives the
  // first rendered option the one cobalt action treatment; do not silently
  // reorder the alternatives around the legacy `recommended` hint.
  // A card with allowed values (ADR-037 §2) offers exactly those, in order.
  const options: V2DecisionOption[] = allowed
    ? allowed.map((item) => decision.options.find((option) => (
      option.label.toLowerCase() === item.value.toLowerCase()
    )) || { label: item.value })
    : decision.options;

  return (
    <article className={`v2-decision-card${ruling ? ' v2-decision-card--ruled' : ''}`} data-testid="decision-card">
      <div className="v2-decision-card__head">
        {decision.actorName && <span className="v2-decision-card__agent">{decision.actorName}</span>}
        <h3>{decision.title}</h3>
      </div>
      {decision.detail && <p className="v2-decision-card__question">{renderPlainWithMentions(decision.detail)}</p>}
      {decision.handBack && <HandBackFields handBack={decision.handBack} />}
      {ruling ? (
        <p className="v2-decision-card__settled" role="status">
          {ruling.reason
            ? t('activity.decision.ruledWithReason', { by: ruling.byName || ruling.by, value: ruling.value, reason: ruling.reason })
            : t('activity.decision.ruled', { by: ruling.byName || ruling.by, value: ruling.value })}
        </p>
      ) : (
        <div className="v2-decision-card__options">
          {asksReason && (
            <label className="v2-decision-card__reason">
              <span>{t('activity.decision.reasonLabel')}</span>
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder={t('activity.decision.reasonPlaceholder')}
                maxLength={2000}
                rows={2}
                disabled={saving}
                required
              />
            </label>
          )}
          {options.map((option, index) => {
            const optionId = `${decision.id}-${index}`.replace(/[^a-zA-Z0-9_-]/g, '-');
            const recommendedId = `${optionId}-recommended`;
            const descriptionId = `${optionId}-description`;
            const describedBy = option.description ? descriptionId : undefined;
            return (
              <div className="v2-decision-card__option" key={option.label}>
                <button
                  type="button"
                  className={index === 0 ? 'v2-decision-card__choice v2-decision-card__choice--primary' : 'v2-decision-card__choice'}
                  onClick={() => { void choose(option.label); }}
                  disabled={saving || (reasonFor(option.label) && !reason.trim())}
                  aria-label={option.recommended
                    ? t('activity.decision.ruleOptionRecommended', { option: option.label })
                    : undefined}
                  aria-describedby={describedBy}
                >
                  {saving ? t('activity.decision.working') : option.label}
                </button>
                {option.recommended && <span id={recommendedId} className="v2-decision-card__option-recommended">{t('activity.decision.recommended')}</span>}
                {option.description && <span id={descriptionId} className="v2-decision-card__option-description">{option.description}</span>}
              </div>
            );
          })}
          {!allowed && <div className="v2-decision-card__footer">
            <button
              type="button"
              className="v2-decision-card__other"
              onClick={() => setOtherOpen((open) => !open)}
              disabled={saving}
            >
              {t('activity.decision.other')}
            </button>
            {otherOpen && (
              <div className="v2-decision-card__other-form">
                <input
                  ref={otherInputRef}
                  aria-label={t('activity.decision.otherPlaceholder')}
                  value={otherValue}
                  onChange={(event) => setOtherValue(event.target.value)}
                  disabled={saving}
                />
                <button
                  ref={otherSubmitRef}
                  type="button"
                  onClick={() => { otherSubmissionRef.current = true; void choose(otherValue); }}
                  disabled={saving || !otherValue.trim()}
                >
                  {saving ? t('activity.decision.working') : t('activity.decision.sendOther')}
                </button>
              </div>
            )}
          </div>}
        </div>
      )}
      {error && <p className="v2-decision-card__error" role="alert">{error}</p>}
    </article>
  );
};

interface HandBackRecordWire {
  id: string;
  status: string;
  asked?: { text?: string; provenance?: string; requesterUserId?: string } | null;
  plan?: { text?: string } | null;
  next?: { agentName?: string } | null;
  changed?: V2HandBackView['changed'];
  checked?: V2HandBackView['checked'];
  unverified?: V2HandBackView['unverified'];
}

/** A GET /api/pods/:podId/hand-backs record, as one card stage shows it. */
export const toHandBackView = (
  record: HandBackRecordWire,
  people: Record<string, string>,
  stage: string | undefined,
): V2HandBackView => {
  const provenance = record.asked?.provenance;
  return {
    status: record.status,
    stage: stage === 'result' ? 'result' : 'plan',
    asked: {
      text: record.asked?.text || '',
      provenance: provenance === 'message' || provenance === 'task' ? provenance : 'owner',
      requesterName: people[String(record.asked?.requesterUserId || '')] || undefined,
    },
    plan: record.plan?.text || undefined,
    changed: record.changed || null,
    checked: record.checked || null,
    unverified: record.unverified || null,
    nextAgent: record.next?.agentName || undefined,
  };
};

export type { HandBackRecordWire };

export default V2DecisionCard;
