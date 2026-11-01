const catalogueRevision = require('../../../config/uiCardCatalogueRevision.json');
const { validateAgentCardPayload, UI_CARD_MAX_BYTES } = require('../../../services/uiCardValidation');

const card = (source = 'root = Text("hello")') => ({ ...catalogueRevision, kind: 'ui', v: 1, lang: 'openui@1', source });
const validate = (payload = card(), content = 'Text fallback', type = 'card') => (
  validateAgentCardPayload(type, payload, content)
);

describe('untrusted UI card write validation', () => {
  it.each([
    { catalogId: 'other.ui' }, { catalogRev: 2 }, { catalogRev: 3 }, { catalogRev: '1' },
    { catalogHash: 'sha256:forged' }, { catalogRev: undefined },
    { catalogId: undefined }, { catalogHash: undefined },
  ])('visibly refuses an unsupported catalogue tuple %#', (fields) => {
    expect(() => validate({ ...card(), ...fields })).toThrow(expect.objectContaining({
      statusCode: 400, code: 'invalid_ui_card', message: expect.stringMatching(/catalog/),
    }));
  });
  it('keeps ordinary text backwards compatible', () => {
    expect(() => validateAgentCardPayload(undefined, undefined, 'hello')).not.toThrow();
  });
  it.each(['system', 'approval', null, 1])('refuses non-agent message type %s without a payload', (type) => {
    expect(() => validateAgentCardPayload(type, undefined, 'hello')).toThrow('text or card');
  });
  it('accepts a complete known component without evaluating it', () => {
    expect(() => validate()).not.toThrow();
    expect(() => validate(card('root = Text("Query Mutation @Run are just quoted text")'))).not.toThrow();
    expect(() => validate(card('root = Text("hello")\nunused = Action(@OpenUrl("https://commonly.me"))'))).not.toThrow();
    expect(() => validate(card('root = Text("# hello 🌍")'))).not.toThrow();
  });
  it.each(['#', '🌍', '`', '\\'])('rejects source characters omitted by tokenization: %s', (suffix) => {
    expect(() => validate(card('root = Text("hello")' + suffix))).toThrow('unsupported source characters');
  });
  it.each([
    null, [], {}, { ...card(), kind: 'approval' }, { ...card(), kind: 'decision' },
    { ...card(), v: 2 }, { ...card(), lang: 'openui@2' },
    { ...card(), source: 5 }, { ...card(), source: '' },
    { ...card(), tools: { secret: 'no' } }, { ...card(), runId: 'forged' },
  ])('refuses an unsupported or privileged envelope %#', (payload) => {
    expect(() => validate(payload)).toThrow(expect.objectContaining({ statusCode: 400, code: 'invalid_ui_card' }));
  });
  it.each([undefined, null, '', '   ', 42])('requires a text fallback (%s)', (content) => {
    expect(() => validateAgentCardPayload('card', card(), content)).toThrow();
  });
  it('requires the explicit card type and a card payload', () => {
    expect(() => validate(card(), 'fallback', 'text')).toThrow();
    expect(() => validateAgentCardPayload('card', undefined, 'fallback')).toThrow();
  });
  it('rejects source lines discarded by the statement splitter', () => {
    expect(() => validate(card('root = Text("hello")\nnot valid'))).toThrow('discarded');
    expect(() => validate(card('garbage\nroot = Text("hello")'))).toThrow('discarded');
    expect(() => validate(card('root = Text("hello")\nunused ='))).toThrow('discarded');
    expect(() => validate(card('root = Text(\n"hello"\n)\n\n'))).not.toThrow();
  });
  it.each([
    'root = Unknown("hello")',
    'root = Text("hello")\nunused = Unknown("hello")',
    'root = Query("tool", {})',
    'root = Text("hello")\nunused = Query("tool", {})',
    'root = Text("hello")\nunused = Mutation("tool", {})',
    'root = Text(Action(@Run(q)))',
    'root = Text("hello")\nunused = Action(@Run(q))',
    'root = Text("hello")\nunused = OpenUrl("javascript:alert(1)")',
    'root = Text("hello")\nunused = Action("javascript:alert(1)")',
    'root = Text("hello")\nunused = OpenUrl("http://example.com")',
    'root = Text("hello")\nunused = Action("http://example.com")',
    'root = Text("hello")\nunused = Action(OpenUrl("javascript:alert(1)"))',
    'root = Text("hello") Query("tool", {})',
    'root = Text("hello") Unknown("hidden")',
    'root = Text(@Fetch("https://example.org"))',
    '$state = "x"\nroot = Text($state)',
    'root = Text("hello"',
    'root = Text(missing)',
    'root = Text("hi")\nroot = Text("replacement")',
    'root = Text({__proto__: {polluted: true}})',
    'root = {type: "element", typeName: "Query", props: {tool: "secret"}}',
    'no root here',
  ])('refuses unsafe, unknown, or incomplete source: %s', (source) => {
    expect(() => validate(card(source))).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
  it.each([
    'root = Card("Plan", [Text("Do it"), Steps([Step("First", "active"), Step("Second", "pending")])])',
    'root = DiffSummary([File("src/main.ts", 4, 2)])',
    'root = TaskStatus("TASK-497", "Read from the board")',
    'root = KeyValue([Pair("Checks", 42), Pair("Ready", true)])',
    'root = Table([Col("Name"), Col("Count", "number")], [["tests", 42]])',
    'root = Badge("Ready", "done")',
    'root = Link("Docs", "https://commonly.me/docs", "text")',
    'root = RunTrace(3)',
    'root = RunTrace()',
    'root = List(["one", "two"], true)',
    'root = Text(["Read ", Link("the docs", "https://commonly.me/docs", "text")])',
  ])('accepts the artboard catalogue: %s', (source) => {
    expect(() => validate(card(source))).not.toThrow();
  });
  it.each([
    'root = Text(' + JSON.stringify('a'.repeat(601)) + ')',
    'root = Card(' + JSON.stringify('a'.repeat(81)) + ', [Text("hi")])',
    'root = Card("Empty", [])',
    'root = List([])',
    'root = Steps([Step("only", "done")])',
    'root = Steps([Step("one", "active"), Step("two", "active")])',
    'root = Steps([Step("one", "unknown"), Step("two", "pending")])',
    'root = DiffSummary([File("file", -1, 0)])',
    'root = RunTrace(0)',
    'root = RunTrace(6)',
    'root = RunTrace(1.5)',
    'root = Badge("Ready", "cobalt")',
    'root = TaskStatus("TASK-1", "note", "done")',
    'root = Table([Col("Name")], [["one", "extra"]])',
    'root = Text(["prefix", Link("button", "https://commonly.me", "button")])',
    'root = Link("unsafe", "http://commonly.me", "text")',
    'root = Link("unsafe", "https://user:password@commonly.me", "text")',
    'root = Link("unsafe", "javascript:alert(1)", "text")',
    'root = Card("Two primary", [Link("one", "https://commonly.me", "primary"), Link("two", "https://commonly.me", "primary")])',
    'root = Card("Three buttons", [Link("one", "https://commonly.me", "button"), Link("two", "https://commonly.me", "button"), Link("three", "https://commonly.me", "button")])',
    'root = Step("not a visual root", "done")',
    'root = Card("wrong helper", [Pair("one", "two")])',
    'root = Text([' + JSON.stringify('a'.repeat(400)) + ', ' + JSON.stringify('b'.repeat(201)) + '])',
  ])('refuses catalogue limits and invalid helper placement: %s', (source) => {
    expect(() => validate(card(source))).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
  it('refuses deeply nested input before recursive parsing', () => {
    expect(() => validate(card('root = Text(' + '['.repeat(1000) + '0' + ']'.repeat(1000) + ')'))).toThrow('nesting');
  });
  it('accepts bounded reuse and rejects direct or indirect reference cycles', () => {
    expect(() => validate(card('leaf = Text("hello")\nroot = Card("Reuse", [leaf, leaf])'))).not.toThrow();
    expect(() => validate(card('root = Card("cycle", [root])'))).toThrow('cyclic references');
    expect(() => validate(card('a = b\nb = a\nroot = Text("safe")'))).toThrow('cyclic references');
  });
  it('enforces exact nesting and statement count boundaries', () => {
    const nested = (count) => 'root = ' + 'Card("title", ['.repeat(count)
      + 'Text(["hello"])' + '])'.repeat(count);
    expect(() => validate(card(nested(31)))).not.toThrow(); // 64 brackets
    expect(() => validate(card(nested(32)))).toThrow('64 nesting');
    const statements = (count) => 'root = Text("hello")\n'
      + Array.from({ length: count - 1 }, (_, i) => 'unused' + i + ' = "literal"').join('\n');
    expect(() => validate(card(statements(256)))).not.toThrow();
    expect(() => validate(card(statements(257)))).toThrow('256 statements');
  });
  it('limits serialized payload bytes, including multibyte Unicode and exact boundary', () => {
    const prefix = 'root = Text("';
    const suffix = '")';
    const exact = card();
    const overhead = Buffer.byteLength(JSON.stringify(exact));
    exact.source += ' '.repeat(UI_CARD_MAX_BYTES - overhead);
    expect(Buffer.byteLength(JSON.stringify(exact))).toBe(UI_CARD_MAX_BYTES);
    expect(() => validate(exact)).not.toThrow();
    expect(() => validate({ ...exact, source: exact.source + ' ' })).toThrow('32 KB');
    expect(() => validate(card(prefix + '界'.repeat(12000) + suffix))).toThrow('32 KB');
  });
});
