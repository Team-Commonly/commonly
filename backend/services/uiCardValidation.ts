import {
  createParser, parseExpression, split, tokenize, walkAST,
} from '@openuidev/lang-core';
import type { ElementNode, LibraryJSONSchema } from '@openuidev/lang-core';
import Ajv from 'ajv';
import catalogue from '../config/uiCardCatalogue.json';

export const UI_CARD_MAX_BYTES = 32 * 1024;
const schema = catalogue as LibraryJSONSchema;
const parser = createParser(schema);
const componentNames = new Set(Object.keys(schema.properties || {}));
const bracketTokens = tokenize('()[]{}');
const closingTokens = new Map([
  [bracketTokens[0].t, bracketTokens[1].t],
  [bracketTokens[2].t, bracketTokens[3].t],
  [bracketTokens[4].t, bracketTokens[5].t],
]);
const openParenToken = bracketTokens[0].t;
const allowedCall = (name: string) => componentNames.has(name) || ['Action', 'OpenUrl'].includes(name);
const helpers = new Set(['Step', 'File', 'Pair', 'Col']);
// lang-core validates prop types but ignores JSON Schema bounds (maxLength,
// minItems, minimum, etc.). Validate its materialized tree as well. References
// name element wrappers so helper/child identity is checked, not only prop shape.
const validateTree = new Ajv({ strict: false }).compile({
  $defs: Object.fromEntries(Object.entries(catalogue.$defs).map(([name, props]) => [name, {
    type: 'object',
    properties: {
      type: { const: 'element' }, typeName: { const: name }, props,
      partial: { type: 'boolean' }, hasDynamicProps: { type: 'boolean' }, statementId: { type: 'string' },
    },
    required: ['type', 'typeName', 'props'],
    additionalProperties: false,
  }])),
  anyOf: Object.keys(catalogue.properties).filter((name) => !helpers.has(name))
    .map((name) => ({ $ref: `#/$defs/${name}` })),
});

function validatePresentation(root: ElementNode): void {
  let buttons = 0;
  let primary = 0;
  function visit(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const node = value as ElementNode;
    if (node.type !== 'element') return;
    const { props } = node;
    if (node.typeName === 'Link') {
      const url = new URL(props.url as string);
      if (url.protocol !== 'https:' || url.username || url.password) refuse('Link requires a credential-free https URL');
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
}


export class UICardValidationError extends Error {
  readonly statusCode = 400;

  readonly code = 'invalid_ui_card';
}

function refuse(message: string): never {
  throw new UICardValidationError(message);
}

/** Validate untrusted CAP input, never privileged kernel-composed payloads. */
export function validateAgentCardPayload(
  messageType: unknown,
  payload: unknown,
  content: unknown,
): void {
  if (messageType !== undefined && messageType !== 'text' && messageType !== 'card') {
    refuse('Agent messageType must be text or card');
  }
  if (payload === undefined && messageType !== 'card') return;
  if (messageType !== 'card') refuse('UI payload requires messageType card');
  if (typeof content !== 'string' || !content.trim()) refuse('UI card requires a content text fallback');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) refuse('UI card payload must be an object');
  const envelope = payload as Record<string, unknown>;
  if (envelope.kind !== 'ui' || envelope.v !== 1 || envelope.lang !== 'openui@1'
    || typeof envelope.source !== 'string' || !envelope.source.trim()
    || Object.keys(envelope).some((key) => !['kind', 'v', 'lang', 'source'].includes(key))) {
    refuse('Expected {kind:"ui",v:1,lang:"openui@1",source}');
  }
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > UI_CARD_MAX_BYTES) {
    refuse('UI card payload exceeds 32 KB');
  }
  try {
    const source = envelope.source as string;
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
        && parseExpression([token]).k !== 'Str' && !allowedCall(token.v)) {
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
    statements.forEach((statement) => {
      if (ids.has(statement.id) || statement.id.startsWith('$')) {
        refuse('UI card contains duplicate or reactive statements');
      }
      ids.add(statement.id);
      walkAST(parseExpression(statement.tokens), (node) => {
        if (node.k === 'Comp') {
          if (!allowedCall(node.name)) {
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
            const parsed = new URL(url.v);
            if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
              refuse('OpenUrl requires a literal https URL');
            }
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
    const result = parser.parse(source);
    if (!result.root || result.meta.incomplete || result.meta.unresolved.length
      || result.meta.errors.length || result.queryStatements.length || result.mutationStatements.length
      || Object.keys(result.stateDeclarations).length) {
      refuse('UI card source is incomplete or invalid for the Commonly catalogue');
    }
    if (!validateTree(result.root)) refuse('UI card props violate the Commonly catalogue');
    validatePresentation(result.root);
  } catch (error) {
    if (error instanceof UICardValidationError) throw error;
    refuse('UI card source could not be parsed');
  }
}
