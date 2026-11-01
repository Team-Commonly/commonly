/**
 * TASK-607: catalogue revision 2 adds Source(connector, fetchedAt). It names a
 * vendor origin, so only the server writes it; an agent can never claim one.
 */
const revision1 = require('../../../config/uiCardCatalogueRevision.json');
const revision2 = require('../../../config/uiCardCatalogueRevision.rev2.json');
const catalogue1 = require('../../../config/uiCardCatalogue.json');
const catalogue2 = require('../../../config/uiCardCatalogue.rev2.json');
const {
  validateAgentCardPayload, stampCardSource, UI_CARD_SOURCE_CATALOGUE, UI_CARD_SOURCE_CONNECTORS,
} = require('../../../services/uiCardValidation');

const envelope = (source, pin = revision1) => ({
  kind: 'ui', v: 1, lang: 'openui@1', source, ...pin, 
});
const agent = (payload) => validateAgentCardPayload('card', payload, 'Text fallback');
const issues = 'root = Card("Open issues", [Text("Two need a reply")], "linear")';
const fetchedAt = '2026-11-01T09:30:00.000Z';
const refused = (message) => expect.objectContaining({ statusCode: 400, code: 'invalid_ui_card', message: expect.stringMatching(message) });

describe('catalogue revision 2', () => {
  it('adds only Source to revision 1, leaving every revision 1 component unchanged', () => {
    const added = Object.keys(catalogue2.$defs).filter((name) => !(name in catalogue1.$defs));
    expect(added).toEqual(['Source']);
    expect(Object.keys(catalogue2.properties)).toEqual([...Object.keys(catalogue1.properties), 'Source']);
    Object.keys(catalogue1.$defs).filter((n) => n !== 'Card').forEach((name) => {
      expect(catalogue2.$defs[name]).toEqual(catalogue1.$defs[name]);
    });
    expect(catalogue2.$defs.Card.properties.children.items.anyOf)
      .toEqual([...catalogue1.$defs.Card.properties.children.items.anyOf, { $ref: '#/$defs/Source' }]);
    // Positional ABI: connector first, then fetchedAt.
    expect(Object.keys(catalogue2.$defs.Source.properties)).toEqual(['connector', 'fetchedAt']);
    expect(revision2).toEqual(expect.objectContaining({ catalogId: revision1.catalogId, catalogRev: 2 }));
    expect(revision2.catalogHash).not.toBe(revision1.catalogHash);
    expect(UI_CARD_SOURCE_CATALOGUE).toEqual(revision2);
    expect(UI_CARD_SOURCE_CONNECTORS).toEqual(['linear', 'sentry', 'atlassian']);
  });
  it('accepts an agent card under either revision when it has no Source', () => {
    expect(() => agent(envelope(issues))).not.toThrow();
    expect(() => agent(envelope(issues, revision2))).not.toThrow();
  });
  it.each([{ catalogRev: 3 }, { catalogRev: 2, catalogHash: revision1.catalogHash }, { catalogRev: 1, catalogHash: revision2.catalogHash }])(
    'refuses an unknown or mismatched revision tuple %#',
    (fields) => expect(() => agent({ ...envelope(issues), ...fields })).toThrow(refused(/catalog/)),
  );
});

describe('agent-written Source', () => {
  it.each([
    ['revision 2, in a Card', 'root = Card("Issues", [Text("x"), Source("linear", "2026-11-01T09:30:00.000Z")])', revision2],
    ['revision 2, as a dormant statement', 'root = Text("x")\nlater = Source("sentry", "2026-11-01T09:30:00.000Z")', revision2],
    ['revision 2, by reference', 's = Source("linear", "2026-11-01T09:30:00.000Z")\nroot = Card("Issues", [Text("x"), s])', revision2],
    ['revision 1', 'root = Card("Issues", [Text("x"), Source("linear", "2026-11-01T09:30:00.000Z")])', revision1],
  ])('is refused: %s', (_label, source, pin) => {
    expect(() => agent(envelope(source, pin))).toThrow(refused(/Source is stamped by the server/));
  });
  it('is refused on a stamped envelope resubmitted through the agent path', () => {
    const stamped = stampCardSource(issues, 'Two open issues', { connector: 'linear', fetchedAt });
    expect(() => agent(stamped)).toThrow(refused(/Source is stamped by the server/));
  });
});

describe('stampCardSource', () => {
  it('appends Source to the top-level Card and returns a revision 2 envelope', () => {
    const stamped = stampCardSource(issues, 'Two open issues', { connector: 'linear', fetchedAt: new Date(fetchedAt) });
    expect(stamped).toEqual({
      kind: 'ui',
      v: 1,
      lang: 'openui@1',
      ...revision2,
      source: 'root = Card("Open issues", [Text("Two need a reply"), Source("linear", "2026-11-01T09:30:00.000Z")], "linear")',
    });
  });
  it('keeps quoted prose, references, links and helpers intact through the reprint', () => {
    const source = [
      'pair = Pair("Owner", "Sam \\"S\\" X")',
      'root = Card("Sentry", [Text(["Line one\\nline two é ", Link("open", "https://sentry.io/x", "text")]), KeyValue([pair, pair]), Table([Col("n", "number")], [[1], [2]])], "2 issues")',
    ].join('\n');
    const { source: out } = stampCardSource(source, 'fallback', { connector: 'sentry', fetchedAt });
    expect(out).toBe('root = Card("Sentry", [Text(["Line one\\nline two é ", Link("open", "https://sentry.io/x", "text")]), '
      + 'KeyValue([Pair("Owner", "Sam \\"S\\" X"), Pair("Owner", "Sam \\"S\\" X")]), Table([Col("n", "number")], [[1], [2]]), '
      + 'Source("sentry", "2026-11-01T09:30:00.000Z")], "2 issues")');
  });
  it('reprints numbers, null table cells and defaulted props exactly', () => {
    const source = 'root = Card("Counts", [Table([Col("n", "number"), Col("s")], [[-5, null], [1.5, "x"]]), RunTrace(), '
      + 'DiffSummary([File("a.ts", 0, 12)]), List(["one"], true)])';
    const { source: out } = stampCardSource(source, 'fallback', { connector: 'atlassian', fetchedAt });
    expect(out).toBe('root = Card("Counts", [Table([Col("n", "number"), Col("s")], [[-5, null], [1.5, "x"]]), RunTrace(3), '
      + 'DiffSummary([File("a.ts", 0, 12)]), List(["one"], true), Source("atlassian", "2026-11-01T09:30:00.000Z")])');
  });
  it.each(['github', 'Linear', '', undefined])('refuses an unknown connector %p', (connector) => {
    expect(() => stampCardSource(issues, 'fallback', { connector, fetchedAt })).toThrow(refused(/connector/));
  });
  it.each(['yesterday', '', '1', '2026-11-01', '2026-11-01T09:30:00Z', '2026-02-30T09:30:00.000Z', '2026-11-01T24:00:00.000Z', 1761989400000, new Date(Number.NaN), '+275760-09-13T00:00:00.000Z'])('refuses an invalid fetchedAt %p', (value) => {
    expect(() => stampCardSource(issues, 'fallback', { connector: 'linear', fetchedAt: value })).toThrow(refused(/fetchedAt|catalogue/));
  });
  it('holds the input to the agent rules, so vendor data cannot carry its own Source', () => {
    const smuggled = 'root = Card("x", [Text("y"), Source("linear", "2026-11-01T09:30:00.000Z")])';
    expect(() => stampCardSource(smuggled, 'fallback', { connector: 'sentry', fetchedAt })).toThrow(refused(/Source is stamped/));
    expect(() => stampCardSource('root = Query("secret")', 'fallback', { connector: 'linear', fetchedAt })).toThrow(refused(/not allowed/));
  });
  it('stamps only a Card root, with room for one more child', () => {
    expect(() => stampCardSource('root = Text("bare")', 'fallback', { connector: 'linear', fetchedAt })).toThrow(refused(/Card root/));
    const full = `root = Card("full", [${Array.from({ length: 6 }, (_, i) => `Text("${i}")`).join(', ')}])`;
    expect(() => stampCardSource(full, 'fallback', { connector: 'linear', fetchedAt })).toThrow(refused(/catalogue/));
  });
  it('requires a text fallback, as every card does', () => {
    expect(() => stampCardSource(issues, '', { connector: 'linear', fetchedAt })).toThrow(refused(/fallback/));
  });
});
