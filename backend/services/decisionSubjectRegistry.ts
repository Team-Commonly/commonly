/**
 * ADR-037 §2: the subject link of a decision card. A card can carry a
 * server-set `subject: { type, id, stage }` naming what it decides. The
 * service that owns that subject registers two things here at server boot:
 *
 * - `checkStage(decision)`: run by `chooseDecision` before a ruling is posted.
 *   It answers whether the subject is still at the stage this card decides.
 * - `onRuled(decision)`: run by `chooseDecision` after the card is durably
 *   ruled. It may return extra fields for the asker's `decision.ruled` payload.
 *
 * `chooseDecision` names no workflow; it only looks the subject type up here.
 * A card whose subject type has no registration is refused (fail closed), so
 * this module must be loaded and filled before any ruling path can run. That
 * is why registration happens at boot (server.ts), never on a module's first
 * import: the Slack and Telegram reply path loads `chooseDecision` lazily.
 *
 * Deliberately dependency-free, so any service can import it without a cycle.
 */

export interface DecisionSubject {
  type: string;
  id: string;
  stage: string;
}

export interface DecisionSubjectHandlers {
  /** True when the subject is still at the card's stage. Throwing counts as false. */
  checkStage: (decision: any) => Promise<boolean>;
  /** After the ruling is final. Returned fields are added to `decision.ruled`. */
  onRuled?: (decision: any) => Promise<Record<string, unknown> | null | void>;
}

const registry = new Map<string, DecisionSubjectHandlers>();

export const registerDecisionSubject = (type: string, handlers: DecisionSubjectHandlers): void => {
  if (!type || typeof handlers?.checkStage !== 'function') {
    throw new Error('A decision subject needs a type and a checkStage function');
  }
  registry.set(type, handlers);
};

export const getDecisionSubject = (type: unknown): DecisionSubjectHandlers | null => (
  typeof type === 'string' ? registry.get(type) || null : null
);

/** Tests only: forget a registration so a fail-closed path can be exercised. */
export const unregisterDecisionSubject = (type: string): void => { registry.delete(type); };

export default { registerDecisionSubject, getDecisionSubject, unregisterDecisionSubject };
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = { registerDecisionSubject, getDecisionSubject, unregisterDecisionSubject };
