import { TextEncoder } from 'util';
Object.assign(global, { TextEncoder });
import { cardHref, parseCard } from '../uiCardSource';

test('parses the canonical positional Card and nested helper grammar', () => {
  expect(parseCard('root = Card("Result", [KeyValue([Pair("Count", 2)]), Steps([Step("Read", "done"), Step("Write", "pending")])])')).not.toBeNull();
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
