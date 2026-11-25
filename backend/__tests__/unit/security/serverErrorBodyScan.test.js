/**
 * F626 guard: a 5xx response in routes/ or controllers/ must not carry the
 * caught error's text. A driver message names hosts, collections, constraint
 * names and SQL fragments, and an HTTP client message can carry a remote's
 * response text. The body answers fixed text; the cause goes to the server log
 * (logOutboundFailure in utils/safeErrorLog).
 *
 * Rule: a `.status(5xx)` call chained to `.json(...)` or `.send(...)` fails
 * when the response argument has `.message`, `.stack`, `String(err)`,
 * `err.toString()`, or a bare error identifier (`{ error }`, `{ err }`).
 *
 * To answer an error we threw on purpose, call `ownErrorMessage(err, [exact
 * messages], fallback)` from utils/safeErrorLog: the literal then holds no
 * `.message` and the exact-match list is reviewable. For any other deliberate
 * case, mark the call's first or last line (or the line above it):
 *   // safe-5xx: our own message
 *
 * A status computed with a 500 fallback (`: 500)`, `|| 500)`, `?? 500)`) or by a
 * `*Status(` helper counts as 5xx too, and there `errorPayload(` is a leak as
 * well, since it carries `e.message`. The same marker applies.
 *
 * Not covered: a status held in a plain variable (`res.status(err.status)`), the
 * typed-error pattern where our own error classes carry their status.
 */
const fs = require('fs');
const path = require('path');

const BACKEND = path.resolve(__dirname, '../../..');
const ROOTS = ['routes', 'controllers', 'middleware'];
const ALLOW = 'safe-5xx: our own message';

const LEAK = new RegExp([
  '(?:\\.|\\?\\.)(?:message|stack)\\b',
  '\\b(?:err|error|e|erro|ex)\\w*\\.toString\\(\\)',
  'String\\(\\s*(?:err|error|e|erro|ex)\\w*\\s*\\)',
  '[{,:]\\s*(?:err|error|e|erro|ex)\\s*(?=[,}])',
  '\\berrorPayload\\(',
].join('|'));

// A status that is 5xx literally, falls back to 500, or comes from a `*Status(` helper.
const COMPUTED_5XX = /^(?:5\d\d|[\s\S]*(?::|\|\||\?\?)\s*5\d\d|[\s\S]*\b\w*[sS]tatus\()/;

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return walk(full);
  return /\.(ts|js)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) ? [full] : [];
});

const callBody = (text, open) => {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '\'' || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return { body: text.slice(open + 1, i), end: i };
    }
  }
  return null;
};

const findViolations = (text) => {
  const lines = text.split('\n');
  const violations = [];
  const status = /\.status\(/g;
  let match = status.exec(text);
  while (match) {
    const arg = callBody(text, match.index + match[0].length - 1);
    const chain = arg && /^\s*\.(?:json|send)\(/.exec(text.slice(arg.end + 1));
    if (arg && chain && COMPUTED_5XX.test(arg.body.trim())) {
      const call = callBody(text, arg.end + 1 + chain[0].length - 1);
      if (call && LEAK.test(call.body)) {
        const first = text.slice(0, match.index).split('\n').length;
        const last = text.slice(0, call.end).split('\n').length;
        const marked = [lines[first - 2], lines[first - 1], lines[last - 1]].join('\n').includes(ALLOW);
        if (!marked) violations.push(`line ${first}: ${lines[first - 1].trim()}`);
      }
    }
    match = status.exec(text);
  }
  return violations;
};

describe('5xx response bodies carry no error text (F626)', () => {
  const files = ROOTS.flatMap((root) => walk(path.join(BACKEND, root)));

  it('flags the leaking shapes and honours the marker', () => {
    expect(findViolations("res.status(500).json({ error: err.message });")).toHaveLength(1);
    expect(findViolations("res.status(500).json({ msg: 'x', error: err?.message });")).toHaveLength(1);
    expect(findViolations("res.status(503)\n  .json({ message: (error as Error).message || 'x' });")).toHaveLength(1);
    expect(findViolations("res.status(500).send(String(err));")).toHaveLength(1);
    expect(findViolations("res.status(502).json({ error: e.toString() });")).toHaveLength(1);
    expect(findViolations("res.status(500).json({ error: err.stack });")).toHaveLength(1);
    expect(findViolations("res.status(500).json({ error });")).toHaveLength(1);
    expect(findViolations("res.status(500).json({ error: 'Failed to x' });")).toHaveLength(0);
    expect(findViolations("res.status(500).json({ error: ownErrorMessage(err, OWN, 'x') });")).toHaveLength(0);
    // a computed status with a 500 fallback, or from a *Status( helper
    expect(findViolations("res.status(ok ? 400 : 500).json({ error: err.message });")).toHaveLength(1);
    expect(findViolations("res.status(e.statusCode || 500).json({ message: e.message });")).toHaveLength(1);
    expect(findViolations("res.status(typeof e.statusCode === 'number' ? e.statusCode : 500).json(errorPayload(error));")).toHaveLength(1);
    expect(findViolations("res.status(skillWriteStatus(e)).json({ error: e.message });")).toHaveLength(1);
    expect(findViolations("res.status(skillWriteStatus(e)).json({ error: 'fixed' });")).toHaveLength(0);
    expect(findViolations("res.status(status).json({ error: err.message });")).toHaveLength(0);
    // 4xx is ours to word
    expect(findViolations("res.status(400).json({ error: err.message });")).toHaveLength(0);
    expect(findViolations("res.status(500).json({ error: err.message }); // safe-5xx: our own message")).toHaveLength(0);
    expect(findViolations("// safe-5xx: our own message\nres.status(500).json({ error: err.message });")).toHaveLength(0);
  });

  it('scans a real set of files', () => {
    expect(files.length).toBeGreaterThan(60);
  });

  it('no route or controller answers a 5xx with the caught error text', () => {
    const offenders = [];
    files.forEach((file) => {
      findViolations(fs.readFileSync(file, 'utf8'))
        .forEach((v) => offenders.push(`${path.relative(BACKEND, file)} ${v}`));
    });
    expect(offenders).toEqual([]);
  });
});
