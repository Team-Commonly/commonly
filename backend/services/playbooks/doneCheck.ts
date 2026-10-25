import type { PlaybookDefinition } from './definition';

export interface StepRecord {
  status: string;
  ruling?: { state?: string };
  completedBy?: string;
  prUrl?: string | null;
}

/** Facts come from stored rows and User records, never a model's summary. */
export const checkPlaybookDone = (
  book: PlaybookDefinition,
  rows: Map<string, StepRecord>,
  people: ReadonlySet<string>,
): { done: boolean; failed: string[] } => {
  const failed: string[] = [];
  for (const step of book.steps) {
    const row = rows.get(step.key);
    if (row?.status !== 'done') failed.push(`${step.title}: not complete`);
    if (step.approval && row?.ruling?.state !== 'approved') failed.push(`${step.title}: approval required`);
    const role = book.roles.find((entry) => entry.key === step.role);
    if (role?.kind === 'person' && step.approval?.act !== 'kernel'
      && (!row?.completedBy || !people.has(row.completedBy))) {
      failed.push(`${step.title}: completion by a person required`);
    }
  }
  for (const statement of book.done) {
    const row = rows.get(statement.step);
    const passed = row && ({
      done: row.status === 'done',
      approved: row.ruling?.state === 'approved',
      'by-person': Boolean(row.completedBy && people.has(row.completedBy)),
      'has-pr': Boolean(row.prUrl),
    })[statement.check];
    if (!passed) failed.push(statement.says);
  }
  return { done: failed.length === 0, failed };
};
