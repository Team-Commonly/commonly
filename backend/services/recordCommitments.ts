/**
 * Keeps people's ids out of a record line's hashed bytes (F265, ADR-033 D7,
 * record-v1 §9). Each id position gets its own salted commitment, and the id
 * goes beside the chain in record_openings, where account deletion can remove
 * it without touching a line. Pure: appendRecord writes the openings.
 *
 * A new field that holds a person's id belongs here. The coverage test in
 * recordCommitments.test.js runs every emitter's lines through this file.
 */
import { randomBytes } from 'crypto';
import type { ChainOpening } from '../repositories/recordChainRepository';

/* eslint-disable @typescript-eslint/no-require-imports, global-require */
const format = require('../vendor/seats/src/record/format') as {
  commitId: (id: string, salt: string) => string;
  isUserId: (value: unknown) => boolean;
};
/* eslint-enable @typescript-eslint/no-require-imports, global-require */

export type LineOpening = Omit<ChainOpening, 'seq'>;

type Actor = { type?: string; id?: string; owner?: string; onBehalfOf?: { id: string; role: string } };
type Input = {
  kind: string;
  actor?: Actor | null;
  data?: Record<string, unknown>;
  /** Whose connection a grant line names, when the grant knows. Never stored. */
  connectionOwner?: string | null;
};

const newSalt = (): string => randomBytes(16).toString('hex');

/** The line to write, with an opening for each id it no longer holds. */
export const commitRecordLine = <T extends Input>(input: T): { input: T; openings: LineOpening[] } => {
  const openings: LineOpening[] = [];
  const commit = (value: string, field: string, subject = value): string => {
    const salt = newSalt();
    const commitment = format.commitId(value, salt);
    openings.push({ commitment, field, subject, value, salt });
    return commitment;
  };
  // An id the writer would refuse stays as it is, so the writer still refuses it.
  const person = (value: unknown, field: string): unknown => (
    format.isUserId(value) && value !== 'policy' ? commit(value as string, field) : value
  );

  const data = JSON.parse(JSON.stringify(input.data || {})) as Record<string, unknown>;
  const original = input.actor;
  // An agent's own id isn't a person's; its owner is, and policies and the
  // system have no one to forget.
  const { connectionOwner: grantOwner, ...line } = input;
  let actor = original;
  if (original) {
    actor = { ...original };
    if (original.type === 'human') actor.id = person(original.id, 'actor.id') as string;
    if (original.owner) actor.owner = person(original.owner, 'actor.owner') as string;
    if (original.onBehalfOf) {
      actor.onBehalfOf = { ...original.onBehalfOf, id: person(original.onBehalfOf.id, 'actor.onBehalfOf.id') as string };
    }
  }
  // A connection is forgotten with the person it belongs to: the grant's owner,
  // or the person who minted a root grant. An agent's owner isn't that person,
  // and an agent or the system is no one to forget it with.
  const minter = original === undefined ? data.issuedBy : original?.type === 'human' && original.id;
  const connectionOwner = grantOwner || (data.parentGrantId ? null : minter);
  ['doneBy', 'decidedBy', 'issuedBy'].forEach((key) => {
    if (key in data) data[key] = person(data[key], `data.${key}`);
  });
  const askedOf = data.askedOf as { id?: string; role?: string } | undefined;
  if (askedOf && askedOf.role !== 'policy') askedOf.id = person(askedOf.id, 'data.askedOf.id') as string;
  const scope = data.scope as { audience?: unknown[]; connectionId?: unknown } | undefined;
  if (scope) {
    if (Array.isArray(scope.audience)) scope.audience = scope.audience.map((id, index) => person(id, `data.scope.audience.${index}`));
    if (typeof scope.connectionId === 'string' && scope.connectionId) {
      // With no one to forget it with, the id is never kept beside the line.
      scope.connectionId = connectionOwner
        ? commit(scope.connectionId, 'data.scope.connectionId', connectionOwner as string)
        : format.commitId(scope.connectionId, newSalt());
    }
  }
  return {
    input: { ...line, ...(input.actor === undefined ? {} : { actor }), ...(input.data === undefined ? {} : { data }) } as T,
    openings,
  };
};
