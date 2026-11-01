import {
  createParser, parseExpression, split, tokenize, walkAST,
} from '@openuidev/lang-core';
import type { ASTNode, ElementNode, LibraryJSONSchema } from '@openuidev/lang-core';
import Ajv from 'ajv';
import { createHash } from 'crypto';
import catalogue from '../config/uiCardCatalogue.json';
import revision from '../config/uiCardCatalogueRevision.json';
import catalogueRev2 from '../config/uiCardCatalogue.rev2.json';
import revisionRev2 from '../config/uiCardCatalogueRevision.rev2.json';

// A revision is immutable: property insertion order is OpenUI's positional ABI.
// Agents author revision 1 (the MCP snapshot serves it). Revision 2 adds only
// Source, which the server stamps; an agent-written Source is always refused.
export const UI_CARD_CATALOGUE = Object.freeze({ ...revision });
export const UI_CARD_SOURCE_CATALOGUE = Object.freeze({ ...revisionRev2 });
export const UI_CARD_SOURCE_CONNECTORS: readonly string[] = Object.freeze(
  [...catalogueRev2.$defs.Source.properties.connector.enum],
);

// Mirrors frontend/src/v2/cards/cardLinks.ts: the same hosts the renderer opens,
// so a card the server accepts is one the client will not render as unavailable.
const UI_LINK_HOSTS = new Set(['commonly.me', 'staging.commonly.me', 'docs.commonly.me', 'github.com', 'linear.app', 'sentry.io']);
const ATLASSIAN_SITE = /^[a-z0-9-]+\.atlassian\.net$/;
export function isApprovedCardLink(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && (UI_LINK_HOSTS.has(url.hostname) || ATLASSIAN_SITE.test(url.hostname));
  } catch { return false; }
}

export const UI_CARD_MAX_BYTES = 32 * 1024;
export const UI_CARD_MAX_EXPANDED_NODES = 2048;
const bracketTokens = tokenize('()[]{}');
const closingTokens = new Map([
  [bracketTokens[0].t, bracketTokens[1].t],
  [bracketTokens[2].t, bracketTokens[3].t],
  [bracketTokens[4].t, bracketTokens[5].t],
]);
const openParenToken = bracketTokens[0].t;
// Components that only ever appear inside a parent, never as the card root.
const notRoot = new Set(['Step', 'File', 'Pair', 'Col', 'Source']);

type Grammar = typeof catalogue;
interface CardRevision {
  pin: typeof revision;
  grammar: Grammar;
  parser: ReturnType<typeof createParser>;
  componentNames: Set<string>;
  validateTree: ReturnType<Ajv['compile']>;
}
function loadRevision(grammar: Grammar, pin: typeof revision): CardRevision {
  const hash = `sha256:${createHash('sha256').update(JSON.stringify(grammar)).digest('hex')}`;
  if (hash !== pin.catalogHash) throw new Error(`UI catalogue revision ${pin.catalogRev} hash mismatch`);
  const schema = grammar as LibraryJSONSchema;
  return {
    pin,
    grammar,
    parser: createParser(schema),
    componentNames: new Set(Object.keys(schema.properties || {})),
    // lang-core validates prop types but ignores JSON Schema bounds (maxLength,
    // minItems, minimum, etc.). Validate its materialized tree as well. References
    // name element wrappers so helper/child identity is checked, not only prop shape.
    validateTree: new Ajv({ strict: false }).compile({
      $defs: Object.fromEntries(Object.entries(grammar.$defs).map(([name, props]) => [name, {
        type: 'object',
        properties: {
          type: { const: 'element' }, typeName: { const: name }, props,
          partial: { type: 'boolean' }, hasDynamicProps: { type: 'boolean' }, statementId: { type: 'string' },
        },
        required: ['type', 'typeName', 'props'],
        additionalProperties: false,
      }])),
      anyOf: Object.keys(grammar.properties).filter((name) => !notRoot.has(name))
        .map((name) => ({ $ref: `#/$defs/${name}` })),
    }),
  };
}
const revisions = [loadRevision(catalogue, revision), loadRevision(catalogueRev2 as Grammar, revisionRev2)];
const allowedCall = (rev: CardRevision, name: string) => (
  rev.componentNames.has(name) || ['Action', 'OpenUrl'].includes(name)
);

function validatePresentation(root: ElementNode): void {
  let buttons = 0;
  let primary = 0;
  let sources = 0;
  function visit(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const node = value as ElementNode;
    if (node.type !== 'element') return;
    const { props } = node;
    if (node.typeName === 'Source') sources += 1;
    if (node.typeName === 'Link') {
      if (!isApprovedCardLink(String(props.url))) refuse('Link requires an approved credential-free https URL');
      if (props.as !== 'text') buttons += 1;
      if (props.as === 'primary') primary += 1;
    }
    if (node.typeName === 'Text' && Array.isArray(props.body)) {
      let length = 0;
      props.body.forEach((part: string | ElementNode) => {
        if (typeof part === 'string') length += [...part].length;
        else {
          if (part.props.as !== 'text') refuse('Inline Text links must use text presentation');
          length += [...String(part.props.label)].length;
        }
      });
      if (length > 600) refuse('Text body exceeds 600 characters');
    }
    if (node.typeName === 'Steps'
      && (props.steps as ElementNode[]).filter((step) => step.props.state === 'active').length > 1) {
      refuse('Steps permits at most one active step');
    }
    if (node.typeName === 'Table'
      && (props.rows as unknown[][]).some((row) => row.length !== (props.columns as unknown[]).length)) {
      refuse('Table row width must match its columns');
    }
    Object.values(props).forEach(visit);
  }
  visit(root);
  if (buttons > 2 || primary > 1) refuse('UI card permits at most two buttons and one primary link');
  const topLevelSources = root.typeName === 'Card'
    ? (root.props.children as ElementNode[]).filter((child) => child.typeName === 'Source').length : 0;
  if (sources > 1 || sources !== topLevelSources) refuse('UI card permits one Source, on the top-level Card');
}


export class UICardValidationError extends Error {
  readonly statusCode = 400;

  readonly code = 'invalid_ui_card';
}

function refuse(message: string): never {
  throw new UICardValidationError(message);
}

/** Bound reference substitution before lang-core allocates a materialized tree. */
function validateExpansionBudget(expressions: Map<string, ASTNode>): void {
  type Cost = { nodes: number; depth: number };
  const measured = new Map<string, Cost>();
  const visiting = new Set<string>();
  function measureStatement(id: string): Cost {
    if (visiting.has(id)) refuse('UI card contains cyclic references');
    const cached = measured.get(id);
    if (cached) return cached;
    visiting.add(id);
    const cost = measureNode(expressions.get(id)!);
    visiting.delete(id);
    measured.set(id, cost);
    return cost;
  }
  function measureNode(node: ASTNode): Cost {
    let children: Cost[] = [];
    if (node.k === 'Ref' && expressions.has(node.n)) children = [measureStatement(node.n)];
    else if (node.k === 'Comp') children = [...node.args, ...Object.values(node.mappedProps || {})].map(measureNode);
    else if (node.k === 'Arr') children = node.els.map(measureNode);
    else if (node.k === 'Obj') children = node.entries.map(([, value]) => measureNode(value));
    const cost = { nodes: 1, depth: 1 };
    for (const child of children) {
      cost.nodes += child.nodes;
      cost.depth = Math.max(cost.depth, child.depth + 1);
      if (cost.nodes > UI_CARD_MAX_EXPANDED_NODES || cost.depth > 128) {
        refuse('UI card exceeds reference expansion budget (2048 nodes / 128 levels)');
      }
    }
    return cost;
  }
  // Include dormant statements: the parser may materialize more than root.
  let total = 0;
  for (const id of expressions.keys()) {
    total += measureStatement(id).nodes;
    if (total > UI_CARD_MAX_EXPANDED_NODES) refuse('UI card exceeds reference expansion budget (2048 nodes)');
  }
}

/** Validate untrusted CAP input, never privileged kernel-composed payloads. */
export function validateAgentCardPayload(
  messageType: unknown,
  payload: unknown,
  content: unknown,
): void {
  validateCardPayload(messageType, payload, content, false);
}

function validateCardPayload(
  messageType: unknown,
  payload: unknown,
  content: unknown,
  serverStamped: boolean,
): ElementNode | undefined {
  if (messageType !== undefined && messageType !== 'text' && messageType !== 'card') {
    refuse('Agent messageType must be text or card');
  }
  if (payload === undefined && messageType !== 'card') return undefined;
  if (messageType !== 'card') refuse('UI payload requires messageType card');
  if (typeof content !== 'string' || !content.trim()) refuse('UI card requires a content text fallback');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) refuse('UI card payload must be an object');
  const envelope = payload as Record<string, unknown>;
  if (envelope.kind !== 'ui' || envelope.v !== 1 || envelope.lang !== 'openui@1'
    || typeof envelope.source !== 'string' || !envelope.source.trim()
    || Object.keys(envelope).some((key) => !['kind', 'v', 'lang', 'source', 'catalogId', 'catalogRev', 'catalogHash'].includes(key))) {
    refuse('Expected {kind:"ui",v:1,lang:"openui@1",catalogId,catalogRev,catalogHash,source}');
  }
  if (envelope.catalogId !== revision.catalogId) refuse('Unsupported UI catalogId');
  const rev = revisions.find((candidate) => candidate.pin.catalogRev === envelope.catalogRev);
  if (!rev) refuse('Unsupported UI catalogRev');
  if (envelope.catalogHash !== rev.pin.catalogHash) refuse('UI catalogHash does not match catalogRev');
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > UI_CARD_MAX_BYTES) {
    refuse('UI card payload exceeds 32 KB');
  }
  return validateCardSource(envelope.source as string, rev, serverStamped);
}

function validateCardSource(source: string, rev: CardRevision, serverStamped: boolean): ElementNode {
  // Source names a vendor origin. Only stampCardSource writes it, so an agent
  // cannot claim a card came from Linear or Sentry, under any revision.
  const callable = (name: string) => {
    if (name === 'Source' && !serverStamped) refuse('UI card Source is stamped by the server, not written by agents');
    return allowedCall(rev, name);
  };
  try {
    // The lexer drops unknown characters. Reject those in the original source,
    // while leaving quoted prose (including Unicode and escapes) untouched.
    let quote = '';
    let escaped = false;
    for (const character of source) {
      if (quote) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === quote) quote = '';
      } else if (character === '"' || character === "'") quote = character;
      else if (!/[a-zA-Z0-9_$@\s()[\]{},:=.?!+*/%<>|&-]/.test(character)) {
        refuse('UI card contains unsupported source characters');
      }
    }
    // The streaming parser intentionally repairs incomplete input. Stored cards
    // must be complete. Inspect ALL statements, including unreachable ones:
    // materializing only root misses a dormant Query or an unknown component.
    const tokens = tokenize(source);
    // Also inspect tokens that the forgiving parser would discard after an
    // expression. Quoted prose has string tokens and is never treated as code.
    const brackets: number[] = [];
    tokens.forEach((token, index) => {
      const closing = closingTokens.get(token.t);
      if (closing !== undefined) {
        brackets.push(closing);
        if (brackets.length > 64) refuse('UI card exceeds 64 nesting levels');
      } else if ([...closingTokens.values()].includes(token.t) && brackets.pop() !== token.t) {
        refuse('UI card contains unmatched brackets');
      }
      if (typeof token.v === 'string' && tokens[index + 1]?.t === openParenToken
        && parseExpression([token]).k !== 'Str' && !callable(token.v)) {
        refuse(`UI card call is not allowed: ${token.v}`);
      }
    });
    if (brackets.length) refuse('UI card contains unmatched brackets');
    const statements = split(tokens);
    const separators = tokenize('\n');
    const separatorTypes = new Set(separators.map((token) => token.t));
    const consumed = new Set(statements.flatMap((statement) => statement.tokens));
    statements.forEach((statement) => {
      let index = tokens.indexOf(statement.tokens[0]) - 1;
      while (index >= 0 && separatorTypes.has(tokens[index].t)) index -= 1;
      consumed.add(tokens[index]); // assignment equals
      consumed.add(tokens[index - 1]); // assignment identifier
    });
    if (tokens.some((token) => !separatorTypes.has(token.t) && !consumed.has(token))) {
      refuse('UI card contains source discarded by the statement splitter');
    }
    if (statements.length > 256) refuse('UI card exceeds 256 statements');
    const ids = new Set<string>();
    const expressions = new Map<string, ASTNode>();
    statements.forEach((statement) => {
      if (ids.has(statement.id) || statement.id.startsWith('$')) {
        refuse('UI card contains duplicate or reactive statements');
      }
      ids.add(statement.id);
      const expression = parseExpression(statement.tokens);
      expressions.set(statement.id, expression);
      walkAST(expression, (node) => {
        if (node.k === 'Comp') {
          if (!callable(node.name)) {
            refuse(`UI card call is not allowed: ${node.name}`);
          }
          if (node.fn) refuse('UI card functions are not allowed');
          if (node.name === 'Action' && (node.args.length !== 1
            || node.args[0].k !== 'Comp' || node.args[0].name !== 'OpenUrl')) {
            refuse('Action requires one parsed OpenUrl call');
          }
          if (node.name === 'OpenUrl') {
            const [url] = node.args;
            if (node.args.length !== 1 || url?.k !== 'Str') refuse('OpenUrl requires a literal https URL');
            if (!isApprovedCardLink(url.v)) refuse('OpenUrl requires an approved literal https URL');
          }
        } else if (node.k === 'Ref' && ['Query', 'Mutation', 'Run', 'Action', 'OpenUrl'].includes(node.n)) {
          refuse(`UI card capability is not allowed: ${node.n}`);
        } else if (node.k === 'Obj') {
          if (node.entries.some(([key]) => ['__proto__', 'prototype', 'constructor'].includes(key))) {
            refuse('UI card prototype keys are not allowed');
          }
        } else if (!['Str', 'Num', 'Bool', 'Null', 'Arr', 'Ref'].includes(node.k)) {
          refuse('UI card reactive expressions are not allowed');
        }
      });
    });
    validateExpansionBudget(expressions);
    const result = rev.parser.parse(source);
    if (!result.root || result.meta.incomplete || result.meta.unresolved.length
      || result.meta.errors.length || result.queryStatements.length || result.mutationStatements.length
      || Object.keys(result.stateDeclarations).length) {
      refuse('UI card source is incomplete or invalid for the Commonly catalogue');
    }
    if (!rev.validateTree(result.root)) refuse('UI card props violate the Commonly catalogue');
    validatePresentation(result.root);
    return result.root;
  } catch (error) {
    if (error instanceof UICardValidationError) throw error;
    refuse('UI card source could not be parsed');
  }
}

export interface UICardEnvelope {
  kind: 'ui';
  v: 1;
  lang: 'openui@1';
  source: string;
  catalogId: string;
  catalogRev: number;
  catalogHash: string;
}

/** Print a validated, static element tree back to positional OpenUI source. */
function printNode(value: unknown, grammar: Grammar): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map((item) => printNode(item, grammar)).join(', ')}]`;
  const node = value as ElementNode;
  const definition = (grammar.$defs as Record<string, { properties: Record<string, unknown> }>)[node.typeName];
  if (node.type !== 'element' || !definition) refuse('UI card Source stamping met an unknown node');
  const args = Object.keys(definition.properties).map((key) => node.props[key]);
  while (args.length && args[args.length - 1] === undefined) args.pop();
  return `${node.typeName}(${args.map((arg) => printNode(arg, grammar)).join(', ')})`;
}

/**
 * Server-only: append Source(connector, fetchedAt) to a card built from a
 * recorded connector call and return a revision 2 envelope. The input is held
 * to the agent rules first, so vendor data cannot smuggle in its own Source.
 */
export function stampCardSource(
  source: string,
  content: string,
  stamp: { connector: string; fetchedAt: Date | string },
): UICardEnvelope {
  const root = validateCardPayload('card', {
    kind: 'ui', v: 1, lang: 'openui@1', source, ...UI_CARD_CATALOGUE,
  }, content, false)!;
  if (!UI_CARD_SOURCE_CONNECTORS.includes(stamp.connector)) refuse('Unknown UI card Source connector');
  // A Date from the server clock, or its exact ISO form. Date() reads a loose
  // string such as "1" as 2001 and rolls 02-30 over to 03-02, so a string must
  // survive the round trip unchanged.
  const raw = stamp.fetchedAt;
  const fetchedAt = raw instanceof Date ? raw : new Date(typeof raw === 'string' ? raw : Number.NaN);
  if (Number.isNaN(fetchedAt.getTime()) || (!(raw instanceof Date) && fetchedAt.toISOString() !== raw)) {
    refuse('UI card Source requires a valid fetchedAt');
  }
  if (root.typeName !== 'Card') refuse('UI card Source is stamped on a Card root');
  const children = root.props.children as unknown[];
  const rev = revisions.find((candidate) => candidate.pin.catalogRev === UI_CARD_SOURCE_CATALOGUE.catalogRev)!;
  const stamped: ElementNode = {
    ...root,
    props: {
      ...root.props,
      children: [...children, {
        type: 'element', typeName: 'Source', props: { connector: stamp.connector, fetchedAt: fetchedAt.toISOString() },
      }],
    },
  } as ElementNode;
  const envelope: UICardEnvelope = {
    kind: 'ui', v: 1, lang: 'openui@1', ...UI_CARD_SOURCE_CATALOGUE,
    source: `root = ${printNode(stamped, rev.grammar)}`,
  };
  // The Card's own bounds (six children, 32 KB) still apply after the stamp.
  validateCardPayload('card', envelope, content, true);
  return envelope;
}
