/**
 * A decision card is a relay-only view of an already-persisted decision
 * request. It crosses the outbound dispatch seam, but deliberately never
 * becomes part of the workspace message payload.
 */
export interface DecisionCardOption {
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface DecisionRelayCard {
  // The request is posted before its DecisionRequest row exists. Channel
  // replies bind through the persisted pod message id, not this optional id.
  decisionId?: string;
  title: string;
  question: string;
  options: DecisionCardOption[];
  context?: string;
}
