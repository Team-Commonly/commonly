import { createParser, parseExpression, split, tokenize, walkAST } from '@openuidev/lang-core';
import type { ElementNode, LibraryJSONSchema } from '@openuidev/lang-core';
import Ajv from 'ajv';
import catalogue from './uiCardCatalogue.json';
import revision from './uiCardCatalogueRevision.json';
import catalogueRev2 from './uiCardCatalogue.rev2.json';
import revisionRev2 from './uiCardCatalogueRevision.rev2.json';
import catalogueRev3 from './uiCardCatalogue.rev3.json';
import revisionRev3 from './uiCardCatalogueRevision.rev3.json';

import { cardHref } from './cardLinks';
export { cardHref } from './cardLinks';
const notRoot = new Set(['Step', 'File', 'Pair', 'Col', 'Source', 'Series']);

type Ast = { k?: string; name?: string; args?: Ast[]; els?: Ast[]; v?: unknown };
/** The one ToAssistant step of a parsed Action, bare or as a one-step list (as on the server). */
function choiceStep(action: Ast): Ast | undefined {
  const args = action?.args || [];
  if (args.length !== 1) return undefined;
  const step = args[0].k === 'Arr' && args[0].els?.length === 1 ? args[0].els[0] : args[0];
  return step.k === 'Comp' && step.name === 'ToAssistant' ? step : undefined;
}
/** The choice a validated Button sends. */
export const cardChoiceOf = (action: unknown): string => String(choiceStep(action as Ast)?.args?.[0]?.v ?? '');
export interface CardChoiceOption { label: string; value: string }
/** Every acting Button of a checked card, in source order. */
export function cardChoices(root: ElementNode | null): CardChoiceOption[] {
  const found: CardChoiceOption[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object' && (v as ElementNode).type === 'element') {
      const node = v as ElementNode;
      if (node.typeName === 'Button') found.push({ label: String(node.props.label), value: cardChoiceOf(node.props.action) });
      else Object.values(node.props).forEach(visit);
    }
  };
  visit(root);
  return found;
}

/**
 * One reader per stored revision. Revision 2 only adds the server-stamped
 * Source; revision 3 is revision 1 plus Progress, the charts and acting Buttons.
 */
export interface CardRevision {
  catalogId: string; catalogRev: number; catalogHash: string;
  grammar: LibraryJSONSchema & { $defs: Record<string, { properties: Record<string, unknown> }> };
  names: Set<string>;
  parser: ReturnType<typeof createParser>;
  validate: ReturnType<Ajv['compile']>;
}
const reader = (grammar: typeof catalogueRev2, pin: typeof revision): CardRevision => {
  const names = new Set(Object.keys(grammar.properties));
  return {
    ...pin, grammar: grammar as CardRevision['grammar'], names,
    parser: createParser(grammar as LibraryJSONSchema),
    validate: new Ajv({ strict: false }).compile({
      $defs: Object.fromEntries(Object.entries(grammar.$defs).map(([name, props]) => [name, {
        type: 'object', properties: { type: { const: 'element' }, typeName: { const: name }, props,
          partial: { type: 'boolean' }, hasDynamicProps: { type: 'boolean' }, statementId: { type: 'string' } },
        required: ['type', 'typeName', 'props'], additionalProperties: false,
      }])),
      anyOf: [...names].filter(name => !notRoot.has(name)).map(name => ({ $ref: `#/$defs/${name}` })),
    }),
  };
};
const CARD_REVISIONS: readonly CardRevision[] = [
  reader(catalogue as typeof catalogueRev2, revision), reader(catalogueRev2, revisionRev2),
  reader(catalogueRev3 as unknown as typeof catalogueRev2, revisionRev3),
];
/** The reader for a stored payload's exact tuple, or undefined: unknown revisions never mount. */
export function cardRevision(payload: { catalogId?: unknown; catalogRev?: unknown; catalogHash?: unknown } | null | undefined) {
  return CARD_REVISIONS.find(r => payload?.catalogId === r.catalogId && payload?.catalogRev === r.catalogRev
    && payload?.catalogHash === r.catalogHash);
}

/** Stored cards are complete static documents. Never mount a rejected source. */
export function parseCard(source: unknown, rev: CardRevision = CARD_REVISIONS[0]): ElementNode | null {
  const { names, parser, validate } = rev;
  const acts = names.has('Button');
  const callable = (name: string) => names.has(name) || ['Action', 'OpenUrl'].includes(name) || (acts && name === 'ToAssistant');
  if (typeof source !== 'string' || new TextEncoder().encode(source).length > 32 * 1024) return null;
  // lang-core's parser lifts the code out of a ``` fence before it parses, so
  // the program it renders could differ from the one checked below.
  if (source.includes('```')) return null;
  try {
    // The forgiving lexer drops characters such as # outside quoted prose. A
    // // comment outside quotes is refused too: the parser strips it, and a
    // lexer that doesn't would read a quote inside it as opening a string.
    let quote = ''; let escaped = false; let previous = '';
    for (const c of source) {
      if (quote) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '/' && previous === '/') return null;
      else if (!/[a-zA-Z0-9_$@\s()[\]{},:=.?!+*/%<>|&-]/.test(c)) return null;
      previous = quote ? '' : c;
    }
    const tokens = tokenize(source);
    const pairs = tokenize('()[]{}');
    const closing = new Map([[pairs[0].t, pairs[1].t], [pairs[2].t, pairs[3].t], [pairs[4].t, pairs[5].t]]);
    const stack: number[] = [];
    for (const [index, t] of tokens.entries()) {
      if (closing.has(t.t)) { stack.push(closing.get(t.t)!); if (stack.length > 64) return null; }
      else if ([...closing.values()].includes(t.t) && stack.pop() !== t.t) return null;
      if (typeof t.v === 'string' && tokens[index + 1]?.t === pairs[0].t
        && parseExpression([t]).k !== 'Str' && !callable(t.v)) return null;
    }
    if (stack.length) return null;
    const statements = split(tokens);
    if (statements.length > 256 || new Set(statements.map(s => s.id)).size !== statements.length) return null;
    for (const s of statements) {
      if (s.id.startsWith('$')) return null;
      const steps = new Set<unknown>();
      const choiceCalls: unknown[] = [];
      walkAST(parseExpression(s.tokens), n => {
        if (n.k === 'Comp') {
          if (n.fn || !callable(n.name)) throw new Error('Unsupported capability');
          if (n.name === 'Action') {
            const step = acts ? choiceStep(n as Ast) : undefined;
            if (step) steps.add(step);
            else if (n.args.length !== 1 || n.args[0]?.k !== 'Comp' || n.args[0].name !== 'OpenUrl') throw new Error('Action requires one parsed OpenUrl or ToAssistant');
          }
          if (n.name === 'OpenUrl' && (n.args.length !== 1 || n.args[0]?.k !== 'Str' || !cardHref(n.args[0].v))) throw new Error('Link refused');
          if (n.name === 'ToAssistant') {
            choiceCalls.push(n);
            const [choice] = n.args;
            if (n.args.length !== 1 || choice?.k !== 'Str' || !choice.v.trim() || [...choice.v].length > 80) throw new Error('Choice refused');
          }
        } else if (n.k === 'Ref' && ['Query', 'Mutation', 'Run', 'Action', 'OpenUrl', 'ToAssistant'].includes(n.n)) {
          throw new Error('Capability must be a permitted parsed call');
        } else if (!['Str', 'Num', 'Bool', 'Null', 'Arr', 'Ref'].includes(n.k)) throw new Error('Not static');
      });
      if (choiceCalls.some(call => !steps.has(call))) return null;
    }
    // Count repeated references BEFORE lang-core materializes them. Memoized
    // costs saturate at the cap; a tiny DAG cannot cause exponential work.
    const asts = new Map(statements.map(s => [s.id, parseExpression(s.tokens)]));
    const costs = new Map<string, number>();
    const cost = (id: string, path = new Set<string>()): number => {
      if (path.has(id) || path.size >= 64) throw new Error('Reference cycle or depth');
      if (costs.has(id)) return costs.get(id)!;
      const ast = asts.get(id);
      if (!ast) throw new Error('Unresolved reference');
      const next = new Set(path).add(id);
      let count = 0;
      walkAST(ast, n => {
        count += n.k === 'Ref' ? cost(n.n, next) : 1;
        if (count > 4096) throw new Error('Reference expansion limit');
      });
      costs.set(id, count);
      return count;
    };
    let expanded = 0;
    for (const id of asts.keys()) { expanded += cost(id); if (expanded > 4096) return null; }
    const r = parser.parse(source);
    let materialized = 0;
    const bound = (value: unknown, depth = 0) => {
      if (++materialized > 4096 || depth > 128) throw new Error('Materialized tree limit');
      if (value && typeof value === 'object') Object.values(value).forEach(v => bound(v, depth + 1));
    };
    bound(r.root);
    if (!r.root || r.meta.incomplete || r.meta.errors.length || r.meta.unresolved.length
      || r.queryStatements.length || r.mutationStatements.length || Object.keys(r.stateDeclarations).length
      || !validate(r.root)) return null;
    let buttons = 0; let primary = 0; let sources = 0;
    const choices: string[] = []; const labels: string[] = [];
    const inspect = (node: ElementNode) => {
      if (node.typeName === 'Source') sources++;
      if (node.typeName === 'Button') {
        // As on the server: one ToAssistant step whose value is the label, no @.
        const choice = cardChoiceOf(node.props.action);
        if (!choiceStep(node.props.action as Ast) || choice !== String(node.props.label)
          || choice !== choice.trim() || choice.includes('@')) throw new Error('Button choice');
        choices.push(choice.toLocaleLowerCase());
        labels.push(String(node.props.label));
        if (node.props.as === 'primary') primary++;
        return;
      }
      if ((node.typeName === 'BarChart' || node.typeName === 'LineChart')
        && (node.props.series as ElementNode[]).some(s => (s.props.values as unknown[]).length !== (node.props.labels as unknown[]).length)) throw new Error('Series length');
      if (node.typeName === 'Link') {
        if (node.props.as !== 'text') buttons++;
        if (node.props.as === 'primary') primary++;
      }
      if (node.typeName === 'Steps' && (node.props.steps as ElementNode[]).filter(n => n.props.state === 'active').length > 1) throw new Error('Multiple active steps');
      if (node.typeName === 'Table' && (node.props.rows as unknown[][]).some(row => row.length !== (node.props.columns as unknown[]).length)) throw new Error('Row width mismatch');
      const visit = (v: unknown) => {
        if (Array.isArray(v)) v.forEach(visit);
        else if (v && typeof v === 'object' && (v as ElementNode).type === 'element') inspect(v as ElementNode);
      };
      Object.values(node.props).forEach(visit);
    };
    inspect(r.root);
    if (buttons > 2 || primary > 1) return null;
    if (choices.length && (choices.length < 2 || choices.length > 4 || new Set(choices).size !== choices.length
      || new Set(labels).size !== labels.length)) return null;
    // As on the server: at most one Source, and only on the top-level Card.
    const topSources = r.root.typeName === 'Card' ? (r.root.props.children as ElementNode[]).filter(n => n.typeName === 'Source').length : 0;
    if (sources > 1 || sources !== topSources) return null;
    return r.root;
  } catch { return null; }
}
