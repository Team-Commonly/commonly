import { TextEncoder } from 'util';
Object.assign(global, { TextEncoder });
import { cardHref, parseCard } from '../uiCardSource';

test('parses the canonical positional Card and nested helper grammar', () => {
  expect(parseCard('root = Card("Result", [KeyValue([Pair("Count", 2)]), Steps([Step("Read", "done"), Step("Write", "pending")])])')?.typeName).toBe('Card');
});
test('refuses incomplete source, capabilities, helpers at root, and oversized values', () => {
  for (const source of ['root = Card("Oops", [', 'root = Query("x")', 'root = Text(@Run("x"))', 'root = Pair("x", 1)', `root = Text("${'a'.repeat(601)}")`]) {
    expect(parseCard(source)).toBeNull();
  }
});
test('permits only exact approved HTTPS hosts without credentials or ports', () => {
  expect(cardHref('https://github.com/org/repo')?.hostname).toBe('github.com');
  for (const url of ['javascript:alert(1)', 'http://github.com', 'https://github.com.evil.test/', 'https://github.com@evil.test/', 'https://user:pass@github.com', 'https://github.com:444']) {
    expect(cardHref(url)).toBeNull();
  }
});

test('permits the Linear, Sentry and Atlassian site hosts and refuses lookalikes', () => {
  for (const url of ['https://linear.app/x', 'https://sentry.io/x', 'https://acme.atlassian.net/x']) {
    expect(cardHref(url)?.href).toBe(url);
  }
  for (const url of ['https://linear.app.evil.com', 'https://evilatlassian.net', 'https://atlassian.net.evil.com', 'https://sentry.io.evil.com', 'http://linear.app/x', 'https://user:pw@linear.app', 'https://linear.app:8443', 'https://a.b.atlassian.net']) {
    expect(cardHref(url)).toBeNull();
  }
});

test.each([
  'OpenUrl("javascript:alert(1)")',
  'Action(OpenUrl("javascript:alert(1)"))',
  'Action',
  'OpenUrl',
  'Query("private")',
  'Mutation("private")',
  'Run("private")',
  'Unknown("x")',
])('refuses dormant expression %s before mounting the runtime', dormant => {
  expect(parseCard(`root = Text("Safe root")\nunused = ${dormant}`)).toBeNull();
});

test('accepts a static root with a dormant approved HTTPS action control', () => {
  expect(parseCard('root = Text("Safe root")\nunused = Action(@OpenUrl("https://github.com/org/repo"))')).not.toBeNull();
});

const statements = (count: number) => Array.from({length:count}, (_, i) => `${i === 0 ? "root" : `s${i}`} = Text("ok")`).join('\n');
const nested = (count: number) => `root = Text("ok")\nunused = ${'['.repeat(count)}1${']'.repeat(count)}`;
const links = (styles: string[]) => `root = Card("Links", [${styles.map((style, i) => `Link("${i}", "https://github.com", "${style}")`).join(',')}])`;
const graph = (levels: number) => ['root = n0', ...Array.from({length:levels}, (_, i) => `n${i} = Card("Node", [${Array(6).fill(i + 1 === levels ? 'Text("Leaf")' : `n${i+1}`).join(',')}])`)].join('\n');
test.each([
  ['byte limit', 'root = Text("ok")' + ' '.repeat(32768), 'root = Text("ok")' + ' '.repeat(32000)],
  ['nesting limit', nested(65), nested(63)],
  ['statement limit', statements(257), statements(256)],
  ['duplicate identifiers', 'root = Text("one")\nroot = Text("two")', 'root = Text("one")\nother = Text("two")'],
  ['reactive identifiers', '$root = Text("one")', 'root = Text("one")'],
  ['active steps', 'root = Steps([Step("A", "active"), Step("B", "active")])', 'root = Steps([Step("A", "active"), Step("B", "done")])'],
  ['table width', 'root = Table([Col("A"),Col("B")], [[1]])', 'root = Table([Col("A"),Col("B")], [[1,2]])'],
  ['button count', links(['button','button','button']), links(['button','button'])],
  ['primary count', links(['primary','primary']), links(['primary','button'])],
  ['OpenUrl host', 'root = Text("ok")\nunused = Action(@OpenUrl("https://evil.test"))', 'root = Text("ok")\nunused = Action(@OpenUrl("https://github.com"))'],
  ['reference expansion', graph(7), graph(2)],
  ['reference cycle', 'root = Card("Cycle", [root])', 'root = Card("Safe", [Text("leaf")])'],
  ['discarded characters', 'root = Text("ok")#', 'root = Text("ok # prose")'],
])('%s refuses the bad input and accepts its nearby control', (_label, bad, good) => {
  expect(parseCard(bad)).toBeNull();
  expect(parseCard(good)).not.toBeNull();
});
