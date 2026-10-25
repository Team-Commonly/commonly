import Ajv from 'ajv';

export interface PlaybookRole { key: string; kind: 'agent' | 'person' }
export interface PlaybookStep {
  key: string;
  title: string;
  role: string;
  do: string;
  reads?: string[];
  delivers?: 'post' | 'pr';
  approval?: { by: string; act: 'kernel' | 'actor'; effect?: 'none' };
  writeGap?: string;
}
export interface DoneStatement { says: string; check: 'done' | 'approved' | 'by-person' | 'has-pr'; step: string }
export interface PlaybookDefinition {
  v: 1;
  roles: PlaybookRole[];
  steps: PlaybookStep[];
  done: DoneStatement[];
}

export class PlaybookError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}

const key = { type: 'string', pattern: '^[a-z][a-z0-9-]{0,39}$' };
const text = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength, pattern: '\\S' });
const validate = new Ajv({ allErrors: true }).compile({
  type: 'object', required: ['v', 'roles', 'steps', 'done'], additionalProperties: false,
  properties: {
    v: { const: 1 },
    roles: { type: 'array', minItems: 1, maxItems: 24, items: {
      type: 'object', required: ['key', 'kind'], additionalProperties: false,
      properties: { key, kind: { enum: ['agent', 'person'] } },
    } },
    steps: { type: 'array', minItems: 1, maxItems: 64, items: {
      type: 'object', required: ['key', 'title', 'role', 'do'], additionalProperties: false,
      properties: {
        key, role: key, title: text(160), do: text(8000), writeGap: text(80),
        reads: { type: 'array', maxItems: 64, uniqueItems: true, items: text(160) },
        delivers: { enum: ['post', 'pr'] },
        approval: { type: 'object', required: ['by', 'act'], additionalProperties: false,
          properties: { by: key, act: { enum: ['kernel', 'actor'] }, effect: { const: 'none' } } },
      },
    } },
    done: { type: 'array', minItems: 1, maxItems: 64, items: {
      type: 'object', required: ['says', 'check', 'step'], additionalProperties: false,
      properties: { says: text(240), check: { enum: ['done', 'approved', 'by-person', 'has-pr'] }, step: key },
    } },
  },
});

/** The stored contract is deliberately limited to slices 1–3. */
export const validatePlaybook = (input: unknown): PlaybookDefinition => {
  if (!validate(input)) {
    throw new PlaybookError('invalid_playbook', `Invalid playbook: ${validate.errors?.map((e) => `${e.instancePath} ${e.message}`).join('; ')}`, 400);
  }
  const book = input as PlaybookDefinition;
  if (Buffer.byteLength(JSON.stringify(book), 'utf8') > 64 * 1024) {
    throw new PlaybookError('invalid_playbook', 'Playbook must fit in 64 KiB', 400);
  }
  const roles = new Map(book.roles.map((role) => [role.key, role.kind]));
  const steps = new Set(book.steps.map((step) => step.key));
  if (roles.size !== book.roles.length || steps.size !== book.steps.length) {
    throw new PlaybookError('duplicate_key', 'Role and step keys must be unique', 400);
  }
  for (const step of book.steps) {
    if (!roles.has(step.role)) throw new PlaybookError('unknown_role', `Unknown role: ${step.role}`, 400);
    if (step.approval && roles.get(step.approval.by) !== 'person') {
      throw new PlaybookError('approver_required', `Step ${step.key} must name a person role as approver`, 400);
    }
    if (step.approval && !book.roles.some((role) => role.kind === 'agent')) {
      throw new PlaybookError('agent_role_required', 'An approval point requires an agent role', 400);
    }
    if (step.writeGap && (roles.get(step.role) !== 'person' || step.approval?.act === 'kernel')) {
      throw new PlaybookError('person_write_gap', 'A write gap needs a person step', 400);
    }
    if (step.approval?.act === 'kernel' && (step.delivers || step.reads?.length)) {
      throw new PlaybookError('kernel_effect_unsupported', 'A kernel point in this release only records approval', 400);
    }
  }
  for (const statement of book.done) {
    if (!steps.has(statement.step)) throw new PlaybookError('unknown_step', `Unknown done-check step: ${statement.step}`, 400);
  }
  return JSON.parse(JSON.stringify(book)) as PlaybookDefinition;
};
