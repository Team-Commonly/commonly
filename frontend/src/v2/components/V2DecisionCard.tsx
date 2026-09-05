import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useV2Api } from '../hooks/useV2Api';

export interface V2DecisionOption {
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface V2DecisionCardData {
  id: string;
  title: string;
  detail?: string;
  actorName?: string;
  options: V2DecisionOption[];
}

export interface V2DecisionRuling {
  value: string;
  by?: string;
  at?: string;
  messageId?: string;
}

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

  const choose = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || saving || ruling) return;
    setSaving(true);
    setError(null);
    try {
      const response = await api.post<{
        decision?: { ruling?: V2DecisionRuling | null };
      }>(`/api/activity/decisions/${encodeURIComponent(decision.id)}/choose`, { value: trimmed });
      const settled = response?.decision?.ruling;
      const next = {
        value: settled?.value || trimmed,
        ...(settled?.by ? { by: settled.by } : {}),
        ...(settled?.at ? { at: settled.at } : {}),
        ...(settled?.messageId ? { messageId: settled.messageId } : {}),
      };
      setRuling(next);
      onRuled?.(decision.id, next);
    } catch (caught) {
      const response = (caught as {
        response?: { status?: number; data?: { decision?: { ruling?: V2DecisionRuling } } };
      }).response;
      const standing = response?.data?.decision?.ruling;
      if (response?.status === 409 && standing?.value) {
        const next = {
          value: standing.value,
          ...(standing.by ? { by: standing.by } : {}),
          ...(standing.at ? { at: standing.at } : {}),
          ...(standing.messageId ? { messageId: standing.messageId } : {}),
        };
        setRuling(next);
        onRuled?.(decision.id, next);
      } else {
        setError(t('activity.decision.actionFailed'));
      }
    } finally {
      setSaving(false);
    }
  };

  const options = [...decision.options]
    .sort((left, right) => Number(Boolean(right.recommended)) - Number(Boolean(left.recommended)));

  return (
    <article className={`v2-decision-card${ruling ? ' v2-decision-card--ruled' : ''}`} data-testid="decision-card">
      <div className="v2-decision-card__head">
        {decision.actorName && <span className="v2-decision-card__agent">{decision.actorName}</span>}
        <h3>{decision.title}</h3>
      </div>
      {decision.detail && <p className="v2-decision-card__question">{decision.detail}</p>}
      {ruling ? (
        <p className="v2-decision-card__settled" role="status">
          {t('activity.decision.ruled', { by: ruling.by, value: ruling.value })}
        </p>
      ) : (
        <div className="v2-decision-card__options">
          {options.map((option) => (
            <div className="v2-decision-card__option" key={option.label}>
              <button
                type="button"
                className={option.recommended ? 'v2-decision-card__choice v2-decision-card__choice--recommended' : 'v2-decision-card__choice'}
                onClick={() => { void choose(option.label); }}
                disabled={saving}
              >
                {saving ? t('activity.decision.working') : option.label}
              </button>
              {option.description && <span>{option.description}</span>}
            </div>
          ))}
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
                aria-label={t('activity.decision.otherPlaceholder')}
                value={otherValue}
                onChange={(event) => setOtherValue(event.target.value)}
                disabled={saving}
              />
              <button type="button" onClick={() => { void choose(otherValue); }} disabled={saving || !otherValue.trim()}>
                {saving ? t('activity.decision.working') : t('activity.decision.sendOther')}
              </button>
            </div>
          )}
        </div>
      )}
      {error && <p className="v2-decision-card__error" role="alert">{error}</p>}
    </article>
  );
};

export default V2DecisionCard;
