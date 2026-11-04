// eslint-disable-next-line import/no-unresolved
import Ajv from 'ajv';
// eslint-disable-next-line import/no-unresolved, import/extensions
import Ajv2020 from 'ajv/dist/2020';
import type { ErrorObject, ValidateFunction } from 'ajv';
import { RoomGrantError } from './roomGrantService';

/**
 * F100: a read pin's argument VALUES are checked against the pinned schema
 * before the call, as its names already are (`assertNoUnknown`). A read runs
 * without anyone approving it, so the pin is the only review the call gets: a
 * value outside a pinned enum, or of the wrong type, is refused here rather
 * than reaching the vendor. A write pin is left as it was: its owner approves
 * the exact arguments, and the vendor checks them.
 *
 * Pins are written in two dialects (draft-07 and 2020-12), and a pin with no
 * `$schema` reads as 2020-12, the MCP default. Formats are not checked: they
 * are the vendor's own (`format: 'date-time'` and vendor-specific names), and
 * an unknown one must not refuse every call to a tool.
 */

type Definition = {
  name: string;
  requiredWriteMode: string;
  inputSchema: Record<string, unknown>;
};

const OPTIONS = { strict: false, allErrors: false, validateFormats: false } as const;
const draft07 = new Ajv(OPTIONS);
const draft2020 = new Ajv2020(OPTIONS);

const DRAFT_07 = /^https?:\/\/json-schema\.org\/draft-07\/schema#?$/;

// Compiled once per pinned schema TEXT, not per object: a projection may build
// a fresh object per call (`modelInputSchema` does when a pin withholds an
// argument), and Ajv keeps every schema object it compiles. Keyed by text, the
// cache holds one entry per pin. A schema that cannot be compiled is
// remembered as such, so it refuses without recompiling on every call.
const compiled = new Map<string, ValidateFunction | Error>();

const validatorFor = (schema: Record<string, unknown>): ValidateFunction | Error => {
  const key = JSON.stringify(schema);
  const cached = compiled.get(key);
  if (cached) return cached;
  const { $schema, ...body } = schema;
  let result: ValidateFunction | Error;
  try {
    result = (typeof $schema === 'string' && DRAFT_07.test($schema) ? draft07 : draft2020).compile(body);
  } catch (error) {
    result = error instanceof Error ? error : new Error(String(error));
  }
  compiled.set(key, result);
  return result;
};

// Names the top-level argument and the rule it broke, never the value sent: a
// refusal is read back by the model, and the value may be whatever it was
// steered to try. Below the top level a path segment can be a key the model
// chose (a free-form map), so only the declared name is printed; a nested
// missing field is named from the schema, which is ours.
const describe = (error: ErrorObject | undefined): string => {
  if (!error) return 'arguments do not match the pinned schema';
  const [top] = error.instancePath.split('/').filter(Boolean);
  const missing = error.keyword === 'required' ? (error.params as { missingProperty?: string }).missingProperty : null;
  if (!top) return `tool argument ${missing || '(arguments)'}: ${missing ? 'is required' : error.message}`;
  const nested = error.instancePath.split('/').filter(Boolean).length > 1;
  const rule = missing ? `is missing its required field ${missing}` : error.message;
  return `tool argument ${top}${nested ? ' (a nested value)' : ''}: ${rule}`;
};

export const assertPinnedArgValues = (definition: Definition, args: Record<string, unknown>): void => {
  if (definition.requiredWriteMode !== 'read') return;
  const validate = validatorFor(definition.inputSchema);
  if (validate instanceof Error) {
    throw new RoomGrantError('invalid_tool_args', `${definition.name}: the pinned schema cannot be checked`, 400);
  }
  if (!validate(args)) throw new RoomGrantError('invalid_tool_args', describe(validate.errors?.[0]), 400);
};
