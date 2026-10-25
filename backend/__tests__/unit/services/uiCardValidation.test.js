const { validateAgentCardPayload, UI_CARD_MAX_BYTES } = require('../../../services/uiCardValidation');

const card = (source = 'root = Text("hello")') => ({ kind: 'ui', v: 1, lang: 'openui@1', source });
const validate = (payload = card(), content = 'Text fallback', type = 'card') => (
  validateAgentCardPayload(type, payload, content)
);

describe('untrusted UI card write validation', () => {
  it('keeps ordinary text backwards compatible', () => {
    expect(() => validateAgentCardPayload(undefined, undefined, 'hello')).not.toThrow();
  });
  it('accepts a complete known component without evaluating it', () => {
    expect(() => validate()).not.toThrow();
    expect(() => validate(card('root = Text("Query Mutation @Run are just quoted text")'))).not.toThrow();
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
  it.each([
    'root = Unknown("hello")',
    'root = Text("hello")\nunused = Unknown("hello")',
    'root = Query("tool", {})',
    'root = Text("hello")\nunused = Query("tool", {})',
    'root = Text("hello")\nunused = Mutation("tool", {})',
    'root = Text(Action(@Run(q)))',
    'root = Text("hello")\nunused = Action(@Run(q))',
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
  it('refuses deeply nested input before recursive parsing', () => {
    expect(() => validate(card('root = Text(' + '['.repeat(1000) + '0' + ']'.repeat(1000) + ')'))).toThrow('nesting');
  });
  it('limits serialized payload bytes, including multibyte Unicode and exact boundary', () => {
    const prefix = 'root = Text("';
    const suffix = '")';
    const overhead = Buffer.byteLength(JSON.stringify(card(prefix + suffix)));
    const exact = card(prefix + 'a'.repeat(UI_CARD_MAX_BYTES - overhead) + suffix);
    expect(Buffer.byteLength(JSON.stringify(exact))).toBe(UI_CARD_MAX_BYTES);
    expect(() => validate(exact)).not.toThrow();
    expect(() => validate({ ...exact, source: exact.source + ' ' })).toThrow('32 KB');
    expect(() => validate(card(prefix + '界'.repeat(12000) + suffix))).toThrow('32 KB');
  });
});
