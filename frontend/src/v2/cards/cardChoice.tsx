import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useV2Api } from '../hooks/useV2Api';
import type { CardChoiceOption } from './uiCardSource';

// Catalogue revision 3: a card's acting Buttons are one choice. A click is
// ruled through the same decision path as a decision card, so the agent wakes
// with the choice; the server accepts only a value the stored card offers.

interface Ruling { value: string; by?: string }
interface ChoiceState {
  choices: CardChoiceOption[];
  ruling: Ruling | null;
  pending: string | null;
  error: string | null;
  choose: (value: string) => void;
}
const CardChoice = createContext<ChoiceState | null>(null);

const errorFor = (status?: number) => (status === 403
  ? 'Only people in this pod can choose here.'
  : 'Your choice wasn’t sent. Try again.');

/** One per card that has acting Buttons: reads the standing choice, then sends one. */
export function CardChoiceProvider({ messageId, choices, children }: {
  messageId: string; choices: CardChoiceOption[]; children: React.ReactNode;
}) {
  const api = useV2Api();
  const [ruling, setRuling] = useState<Ruling | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const valid = /^\d{1,18}$/.test(messageId);
  useEffect(() => {
    let active = true;
    if (!valid) return undefined;
    api.get<{ decision?: { ruling?: Ruling | null } | null }>(`/api/activity/cards/${messageId}/choice`)
      .then(data => { if (active && data.decision?.ruling) setRuling(data.decision.ruling); })
      .catch(() => { /* The buttons stay usable; a stale click gets the standing choice back. */ });
    return () => { active = false; };
  }, [api, messageId, valid]);
  const choose = useCallback((value: string) => {
    if (!valid || ruling || pending) return;
    setPending(value);
    setError(null);
    api.post<{ decision?: { ruling?: Ruling } }>(`/api/activity/cards/${messageId}/choose`, { value })
      .then(data => setRuling(data.decision?.ruling || { value }))
      .catch((err: { response?: { status?: number; data?: { decision?: { ruling?: Ruling } } } }) => {
        const standing = err.response?.data?.decision?.ruling;
        if (standing) setRuling(standing);
        else setError(errorFor(err.response?.status));
      })
      .finally(() => setPending(null));
  }, [api, messageId, pending, ruling, valid]);
  return <CardChoice.Provider value={{ choices, ruling, pending, error, choose }}>{children}</CardChoice.Provider>;
}

// The runtime evaluates Action(@ToAssistant(…)) to an empty plan, so a Button
// finds its value by its label in the choices read from the checked parse.
export function CardButton({ label, as }: { label: string; as?: string }) {
  const state = useContext(CardChoice);
  const value = state?.choices.find(choice => choice.label === label)?.value || '';
  const chosen = state?.ruling?.value === value;
  const disabled = !state || !value || !!state.ruling || !!state.pending;
  return <button type="button" className={`ub${as === 'primary' && !state?.ruling ? ' f' : ''}${chosen ? ' on' : ''}`}
    disabled={disabled} aria-pressed={state?.ruling ? chosen : undefined} onClick={() => state?.choose(value)}>
    {chosen && <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m3 8 3 3 7-7" /></svg>}
    {label}
  </button>;
}

/** Who chose what, or why a click didn't go through. Sits in the footer after the buttons. */
export function CardChoiceNote() {
  const state = useContext(CardChoice);
  if (state?.error) return <span className="ui-meta ui-cn" role="alert">{state.error}</span>;
  if (state?.pending) return <span className="ui-meta ui-cn" role="status">Sending…</span>;
  if (state?.ruling) return <span className="ui-meta ui-cn" role="status">{state.ruling.by ? `${state.ruling.by} chose` : 'Chosen'}</span>;
  return null;
}
