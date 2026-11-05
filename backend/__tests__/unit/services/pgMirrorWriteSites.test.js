/**
 * F183: every Mongo write that adds or removes a pod member, or creates a pod,
 * or creates a User, also writes the PG mirror, or is listed below with the reason it does not.
 *
 * On 2026-11-05 production PG held 623 missing memberships, 23 ghosts and 63
 * missing pods, because join, leave, invite redemption, community auto-join,
 * mention auto-join, hire and agent install wrote Mongo only. The nightly
 * repair (pgMirrorRepairService) heals drift, but a new bypass would show up
 * again every night. This scan catches the next one at review time.
 *
 * Sites and mirror calls are found by text and deliberately coarse: a mutation
 * counts as mirrored when a mirror write appears within WINDOW lines after it,
 * in the same function. The TypeScript parser decides what "the same function"
 * means. That is weaker than a behaviour test, so every wired site also has one
 * (pgMirrorWrite.test.js, podController.pgMirror.test.js, pods.rename.test.js).
 * Adding a site to ALLOWED is a decision: say why the mirror may lag.
 */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = path.join(__dirname, '../../..');
const DIRS = ['controllers', 'routes', 'services'];
const MEMBER_WINDOW = 30;
const CREATE_WINDOW = 50;

const MEMBER_MUTATION = [
  /\$addToSet:\s*\{\s*['"]?members\b/,
  /\$push:\s*\{\s*['"]?members\b/,
  /\$pull:\s*\{\s*['"]?members\b/,
  /\$set:\s*\{\s*['"]?members\b/,
  /\.members\s*\.\s*(push|pull|addToSet|splice)\(/,
  /\.members\s*=(?!=)/,
];
const POD_CREATE = [/\bPod\.create\(/, /\bnew Pod\(/];
const USER_CREATE = [/\bUser\.create\(/, /\bnew User\(/, /\bUser\.insertMany\(/];
const USER_WINDOW = 40;
const MIRROR = /mirrorMember(Added|Removed)|mirrorPodCreated|syncPgDmMembers|syncPodFromMongo|PGPod\.(addMember|removeMember|create)|pod_members|ensureGlobalPodPostgresSync/;
const USER_MIRROR = /mirrorUser\(|syncUserToPostgreSQL\(/;

// `file: the source text of the mutation line, trimmed` → why it may lag PG.
const ALLOWED = {
  'services/accountDeletionService.ts: { $pull: { members: userId } });':
    'Mirrored in the same deletion flow by anonymizeChatAuthor, a separate function'
    + ' (DELETE FROM pod_members for the non-DM pods this $pull covers).',
  'controllers/authController.ts: const pod = await Pod.create({':
    'Mirrored by the queued finishWorkspaceOnboarding tail (syncUserToPostgreSQL, then'
    + ' syncPodFromMongo), off the signup response path by design (TASK-149, #3500 review).',
};

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return entry.name === '__tests__' ? [] : walk(full);
  return entry.name.endsWith('.ts') ? [full] : [];
});

// Blanks comments but keeps every newline, so line numbers still match the
// file. Strings are skipped over so a `//` inside a URL is not a comment.
const stripComments = (text) => text.replace(
  /(`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
  (match, str) => (str !== undefined ? str : match.replace(/[^\n]/g, ' ')),
);

const FUNCTION_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);
const INLINE_METHODS = new Set(['map', 'forEach', 'then', 'catch', 'finally']);
const INLINE_FUNCTIONS = new Set(['setTimeout', 'setImmediate']);

// A callback runs as part of the function that wrote it only in a known shape:
// the array and promise methods above, `new Promise(`, a one-shot timer, or
// called on the spot. Anything else may run at any time, so it fails closed and
// stands alone: `router.post(`, `adminRouter.get(`, `cron.schedule(`, `.on(`,
// `wrap(`, `setInterval(`. A write there needs its mirror in that callback.
const isInlineCallback = (node, source) => {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false;
  // `(async () => {...})()` reaches its call through the parentheses.
  const callback = ts.isParenthesizedExpression(node.parent) ? node.parent : node;
  const call = callback.parent;
  if (ts.isNewExpression(call)) return call.expression.getText(source) === 'Promise';
  if (!ts.isCallExpression(call)) return false;
  if (call.expression === callback) return true;
  if (ts.isIdentifier(call.expression)) return INLINE_FUNCTIONS.has(call.expression.text);
  return ts.isPropertyAccessExpression(call.expression) && INLINE_METHODS.has(call.expression.name.text);
};

// The start and end of every function, outermost first. An inline callback
// inside a function gets no span of its own, so what it holds belongs to that
// function, and two inline callbacks in one function count as one. An inline
// callback at the top level has nothing to belong to, so it stands alone.
const functionSpans = (text) => {
  const source = ts.createSourceFile('scan.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const spans = [];
  const visit = (node, insideFunction) => {
    const stands = FUNCTION_KINDS.has(node.kind) && Boolean(node.body)
      && !(insideFunction && isInlineCallback(node, source));
    if (stands) spans.push({ start: node.getStart(source), end: node.end });
    ts.forEachChild(node, (child) => visit(child, insideFunction || stands));
  };
  visit(source, false);
  return spans;
};

// The innermost span holding the offset. Code outside every function gets
// undefined, so the module's top level compares as one function.
const enclosing = (spans, offset) => spans
  .filter(({ start, end }) => start <= offset && offset < end)
  .pop();

const offsetsOf = (code, patterns) => patterns.flatMap((re) => (
  [...code.matchAll(new RegExp(re.source, 'g'))].map((m) => m.index)
));

const lineOf = (code, offset) => code.slice(0, offset).split('\n').length - 1;

// Patterns match across newlines (`\s*` spans them), so a mutation split over
// lines is caught at the line it starts on. A mirror call only counts when it
// is code, never when it is a comment. Blanking comments keeps every offset, so
// spans parsed from the raw text apply to the blanked code.
const scanSource = (text, patterns, window, mirror = MIRROR) => {
  const code = stripComments(text);
  const sites = offsetsOf(code, patterns);
  if (sites.length === 0) return [];
  const lines = code.split('\n');
  const spans = functionSpans(text);
  const mirrors = offsetsOf(code, [mirror])
    .map((offset) => ({ line: lineOf(code, offset), fn: enclosing(spans, offset) }));
  const unvouched = new Set();
  sites.forEach((offset) => {
    const i = lineOf(code, offset);
    if (/PGPod|pg\/Pod/.test(lines[i])) return;
    // Only a mirror write in this function counts. A neighbouring function or
    // standalone callback cannot vouch for this one; an inline callback can,
    // because it is part of this function.
    const fn = enclosing(spans, offset);
    if (!mirrors.some((m) => m.fn === fn && m.line >= i && m.line < i + window)) unvouched.add(i);
  });
  return [...unvouched].sort((a, b) => a - b).map((i) => lines[i].trim());
};

const unmirrored = (patterns, window, mirror = MIRROR) => {
  const found = [];
  for (const dir of DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
      scanSource(fs.readFileSync(file, 'utf8'), patterns, window, mirror)
        .forEach((hit) => found.push(`${path.relative(ROOT, file)}: ${hit}`));
    }
  }
  return found;
};

// #3500 review: the detector itself, on fixtures. Each case is a shape the
// line-by-line scan used to miss, so the scan below could pass while a real
// bypass slipped through.
describe('PG mirror write-site detector', () => {
  const flagged = (src) => scanSource(src, MEMBER_MUTATION, MEMBER_WINDOW);

  it('catches a $pull whose members key sits on the next line', () => {
    expect(flagged([
      'async function leave() {',
      '  await Pod.updateOne({ _id: id }, { $pull: {',
      '    members: userId } });',
      '}',
    ].join('\n'))).toHaveLength(1);
  });

  it('catches $set: { members, .members.pull(, .members.addToSet( and .members.push(', () => {
    ['  await Pod.updateOne({ _id: id }, { $set: { members: next } });',
      '  pod.members.pull(userId);',
      '  pod.members.addToSet(userId);',
      '  pod.members.push(userId);',
    ].forEach((line) => {
      expect(flagged(`async function f() {\n${line}\n}`)).toHaveLength(1);
    });
  });

  it('does not let a mirror call that is only in a comment vouch for a mutation', () => {
    expect(flagged([
      'async function join() {',
      '  pod.members.push(userId);',
      '  // mirrorMemberAdded is not needed here',
      '  /* PGPod.addMember(podId, userId) */',
      '}',
    ].join('\n'))).toHaveLength(1);
  });

  it('ignores a mutation that is itself commented out', () => {
    expect(flagged([
      'async function f() {',
      '  const x = 1; // pod.members.push(userId);',
      '  /* await Pod.updateOne({}, { $pull: { members: u } }); */',
      '}',
    ].join('\n'))).toEqual([]);
  });

  // CodeRabbit on #3500: an ordinary arrow function is a boundary too, or a
  // neighbour's mirror call vouches for this function's write.
  it('does not let a mirror call in the next arrow function vouch for a mutation', () => {
    expect(flagged([
      'const leave = async (pod, userId) => {',
      '  pod.members.push(userId);',
      '};',
      'const join = (podId, userId) => {',
      '  return mirrorMemberAdded(podId, userId);',
      '};',
    ].join('\n'))).toHaveLength(1);
    // Parameters split across lines: the declaration line ends at the open paren.
    expect(flagged([
      'const leave = async (pod, userId) => {',
      '  pod.members.push(userId);',
      '};',
      'const join = (',
      '  podId: string,',
      '  userId: string,',
      ') => mirrorMemberAdded(podId, userId);',
    ].join('\n'))).toHaveLength(1);
    expect(flagged([
      'export const leave = async (pod: Pod, userId: string): Promise<void> => {',
      '  pod.members.push(userId);',
      '};',
      'export const join = async (podId: string): Promise<boolean> => mirrorMemberAdded(podId, u);',
    ].join('\n'))).toHaveLength(1);
  });

  // CodeRabbit on #3500, the two shapes a one-line guess gets wrong.
  it('does not treat a parenthesised value as the start of a function', () => {
    expect(flagged([
      'async function join(pod, userId) {',
      '  pod.members.push(userId);',
      '  const value = (',
      '    userId.toString()',
      '  );',
      '  await mirrorMemberAdded(pod._id, value);',
      '}',
    ].join('\n'))).toEqual([]);
  });

  it('sees a function whose parameter list starts on the declaration line and spans lines', () => {
    expect(flagged([
      'const leave = async (pod, userId) => {',
      '  pod.members.push(userId);',
      '};',
      'const join = (podId: string,',
      '  userId: string,',
      '  role: string,',
      ') => mirrorMemberAdded(podId, userId);',
    ].join('\n'))).toHaveLength(1);
  });

  it('does not treat an if block at method indent as a function', () => {
    expect(flagged([
      'async function join(pod, userId) {',
      '  pod.members.push(userId);',
      '  if (pod.type !== "agent-dm") {',
      '    await mirrorMemberAdded(pod._id, userId);',
      '  }',
      '}',
    ].join('\n'))).toEqual([]);
  });

  // Every kind of function is a boundary: the second one's mirror call must
  // not vouch for the first one's write.
  it.each([
    ['function declarations', [
      'async function leave(pod, userId) {',
      '  pod.members.push(userId);',
      '}',
      'async function join(podId, userId) {',
      '  await mirrorMemberAdded(podId, userId);',
      '}',
    ]],
    ['a function declared inside another', [
      'async function outer(pod, userId) {',
      '  pod.members.push(userId);',
      '  async function inner(podId) {',
      '    await mirrorMemberAdded(podId, userId);',
      '  }',
      '  return inner;',
      '}',
    ]],
    ['function expressions', [
      'const leave = async function (pod, userId) {',
      '  pod.members.push(userId);',
      '};',
      'const join = function (podId, userId) {',
      '  return mirrorMemberAdded(podId, userId);',
      '};',
    ]],
    ['exports assignments', [
      'exports.leave = async (req, res) => {',
      '  req.pod.members.push(req.userId);',
      '};',
      'exports.join = async (req, res) => {',
      '  await mirrorMemberAdded(req.podId, req.userId);',
      '};',
    ]],
    ['class methods with multi-line parameters', [
      'class PodService {',
      '  static async leave(pod, userId) {',
      '    pod.members.push(userId);',
      '  }',
      '',
      '  static async join(',
      '    podId: string,',
      '    userId: string,',
      '  ): Promise<void> {',
      '    await mirrorMemberAdded(podId, userId);',
      '  }',
      '}',
    ]],
    ['class property arrow functions', [
      'class PodService {',
      '  leave = async (pod, userId) => {',
      '    pod.members.push(userId);',
      '  };',
      '',
      '  join = async (podId, userId) => {',
      '    await mirrorMemberAdded(podId, userId);',
      '  };',
      '}',
    ]],
    ['a constructor and the code after its class', [
      'class PodService {',
      '  constructor(pod, userId) {',
      '    pod.members.push(userId);',
      '  }',
      '}',
      'mirrorMemberAdded(podId, userId);',
    ]],
    ['a getter and the code after its class', [
      'class PodService {',
      '  get joined() {',
      '    return this.pod.members.push(this.userId);',
      '  }',
      '}',
      'mirrorMemberAdded(podId, userId);',
    ]],
    ['setters', [
      'class PodService {',
      '  set owner(userId) {',
      '    this.pod.members.push(userId);',
      '  }',
      '',
      '  set joined(userId) {',
      '    mirrorMemberAdded(this.podId, userId);',
      '  }',
      '}',
    ]],
    ['object methods', [
      'const service = {',
      '  async leave(pod, userId) {',
      '    pod.members.push(userId);',
      '  },',
      '  async join(podId, userId) {',
      '    await mirrorMemberAdded(podId, userId);',
      '  },',
      '};',
    ]],
    ['object properties holding functions', [
      'const service = {',
      '  leave: async (pod, userId) => {',
      '    pod.members.push(userId);',
      '  },',
      '  join: async (podId, userId) => {',
      '    await mirrorMemberAdded(podId, userId);',
      '  },',
      '};',
    ]],
    ['route handlers', [
      "router.post('/leave', auth, async (req, res) => {",
      '  req.pod.members.push(req.userId);',
      '});',
      "router.post('/join', auth, async (req, res) => {",
      '  await mirrorMemberAdded(req.podId, req.userId);',
      '});',
    ]],
    ['handlers wrapped at the top level', [
      'export const leave = wrap(async (req, res) => {',
      '  req.pod.members.push(req.userId);',
      '});',
      'export const join = wrap(async (req, res) => {',
      '  await mirrorMemberAdded(req.podId, req.userId);',
      '});',
    ]],
    ['route handlers registered inside a function', [
      'export const mount = (router) => {',
      "  router.post('/leave', auth, async (req, res) => {",
      '    req.pod.members.push(req.userId);',
      '  });',
      "  router.post('/join', auth, async (req, res) => {",
      '    await mirrorMemberAdded(req.podId, req.userId);',
      '  });',
      '};',
    ]],
    ['a returned function and its factory', [
      'const leave = (pod) => {',
      '  pod.members.push(pod.ownerId);',
      '  return async () => {',
      '    await mirrorMemberAdded(pod._id, pod.ownerId);',
      '  };',
      '};',
    ]],
  ])('keeps %s apart', (_name, lines) => {
    expect(flagged(lines.join('\n'))).toHaveLength(1);
  });

  // A named local helper is a function of its own, but one that sits between
  // the write and the mirror does not end the handler it lives in.
  it('reads past a local helper to the mirror call in the same function', () => {
    expect(flagged([
      'async function join(pod, userId) {',
      '  pod.members.push(userId);',
      '  const label = (id: string) => id.toString();',
      '  await mirrorMemberAdded(pod._id, label(userId));',
      '}',
    ].join('\n'))).toEqual([]);
  });

  // An inline callback runs as part of the handler that wrote it, so it is
  // attributed to that handler in both directions.
  it('attributes a write in an inline callback to the handler holding it', () => {
    expect(flagged([
      "router.post('/join', auth, async (req, res) => {",
      '  await Promise.all(req.pods.map(async (pod) => {',
      '    pod.members.push(req.userId);',
      '    await pod.save();',
      '  }));',
      '  await mirrorMemberAdded(req.podId, req.userId);',
      '});',
    ].join('\n'))).toEqual([]);
  });

  it('attributes a mirror call in an inline callback to the handler holding it', () => {
    expect(flagged([
      'async function join(pod, userId) {',
      '  pod.members.push(userId);',
      '  await pod.save();',
      '  void (async () => {',
      '    await mirrorMemberAdded(pod._id, userId);',
      '  })();',
      '}',
    ].join('\n'))).toEqual([]);
    expect(flagged([
      'async function join(pod, userId) {',
      '  pod.members.push(userId);',
      '  setImmediate(function later() {',
      '    mirrorMemberAdded(pod._id, userId);',
      '  });',
      '}',
    ].join('\n'))).toEqual([]);
    expect(flagged([
      'async function join(pod, userId) {',
      '  pod.members.push(userId);',
      '  await new Promise((resolve) => {',
      '    mirrorMemberAdded(pod._id, userId).then(resolve);',
      '  });',
      '}',
    ].join('\n'))).toEqual([]);
  });

  it.each([
    ['.map', '  await Promise.all(pods.map(async (p) => {', '  }));'],
    ['.forEach', '  pods.forEach((p) => {', '  });'],
    ['.then', '  await load().then((p) => {', '  });'],
    ['.catch', '  await load().catch((p) => {', '  });'],
    ['.finally', '  await load().finally(() => {', '  });'],
    ['new Promise', '  await new Promise((resolve) => {', '  });'],
    ['setTimeout', '  setTimeout(() => {', '  }, 10);'],
    ['setImmediate', '  setImmediate(() => {', '  });'],
    ['an immediately called arrow', '  await (async () => {', '  })();'],
    ['an immediately called function', '  await (function run() {', '  })();'],
  ])('treats %s as part of the function around it', (_name, open, close) => {
    expect(flagged([
      'async function join(pod, userId) {',
      open,
      '    pod.members.push(userId);',
      close,
      '  await mirrorMemberAdded(pod._id, userId);',
      '}',
    ].join('\n'))).toEqual([]);
  });

  // #3538 review. An unknown callback may run at any time, so it fails closed:
  // it stands alone, and the mirror belongs inside it.
  const twoCallbacks = {
    'two cron.schedule callbacks': ["  cron.schedule('* * * * *', async () => {", '  });'],
    'two socket.on callbacks': ["  socket.on('event', async (d) => {", '  });'],
    'two bus.on callbacks': ["  bus.on('event', async (d) => {", '  });'],
    'two on callbacks': ["  on('event', async (d) => {", '  });'],
    'two wrap consts': ['  const handler = wrap(async (d) => {', '  });'],
    'two setInterval callbacks': ['  setInterval(async () => {', '  }, 1000);'],
    'two new Worker callbacks': ['  new Worker(async (job) => {', '  });'],
  };

  it.each(Object.entries(twoCallbacks))('keeps %s apart', (_name, [open, close]) => {
    expect(flagged([
      'async function register(pod, userId) {',
      open,
      '    pod.members.push(userId);',
      close,
      open,
      '    await mirrorMemberAdded(pod._id, userId);',
      close,
      '}',
    ].join('\n'))).toHaveLength(1);
  });

  it.each(Object.entries(twoCallbacks))('does not let the outer function vouch for %s', (_name, [open, close]) => {
    expect(flagged([
      'async function register(pod, userId) {',
      open,
      '    pod.members.push(userId);',
      close,
      '  await mirrorMemberAdded(pod._id, userId);',
      '}',
    ].join('\n'))).toHaveLength(1);
  });

  it.each(Object.entries(twoCallbacks))('accepts a mirror in the same callback for %s', (_name, [open, close]) => {
    expect(flagged([
      'async function register(pod, userId) {',
      open,
      '    pod.members.push(userId);',
      '    await mirrorMemberAdded(pod._id, userId);',
      close,
      '}',
    ].join('\n'))).toEqual([]);
  });

  it('lets an inline callback at the top level stand alone', () => {
    expect(flagged([
      'pods.forEach((pod) => {',
      '  pod.members.push(userId);',
      '});',
      'mirrorMemberAdded(podId, userId);',
    ].join('\n'))).toHaveLength(1);
  });

  it('attributes an inline callback to the unknown callback holding it', () => {
    const inCron = (...body) => flagged([
      'async function register(pods, userId) {',
      "  cron.schedule('* * * * *', async () => {",
      '    pods.forEach((pod) => {',
      '      pod.members.push(userId);',
      '    });',
      ...body,
      '  });',
      '  await mirrorMemberAdded(podId, userId);',
      '}',
    ].join('\n'));
    expect(inCron('    await mirrorMemberAdded(podId, userId);')).toEqual([]);
    expect(inCron()).toHaveLength(1);
  });

  it.each(['adminRouter.post', 'publishRouter.post', 'router.get', 'router.put', 'router.patch', 'router.delete'])(
    'keeps two %s handlers in one function apart',
    (route) => {
      expect(flagged([
        'export const mount = () => {',
        `  ${route}('/leave', auth, async (req, res) => {`,
        '    req.pod.members.push(req.userId);',
        '  });',
        `  ${route}('/join', auth, async (req, res) => {`,
        '    await mirrorMemberAdded(req.podId, req.userId);',
        '  });',
        '};',
      ].join('\n'))).toHaveLength(1);
    },
  );

  it('keeps inline callbacks in one handler away from the next handler', () => {
    expect(flagged([
      'async function leave(pods, userId) {',
      '  pods.forEach((pod) => {',
      '    pod.members.push(userId);',
      '  });',
      '}',
      'async function join(pods, userId) {',
      '  pods.forEach((pod) => {',
      '    mirrorMemberAdded(pod._id, userId);',
      '  });',
      '}',
    ].join('\n'))).toHaveLength(1);
  });

  it('still needs the mirror after the write, inside the window', () => {
    expect(flagged([
      'async function join(pod, userId) {',
      '  await mirrorMemberAdded(pod._id, userId);',
      '  pod.members.push(userId);',
      '}',
    ].join('\n'))).toHaveLength(1);
  });

  it('counts a mirror call on the line of the write', () => {
    expect(flagged([
      'async function join(pod, userId) {',
      '  pod.members.push(userId); await mirrorMemberAdded(pod._id, userId);',
      '}',
    ].join('\n'))).toEqual([]);
  });

  // `window` lines starting at the write: the last one counts, the next does not.
  it.each([
    ['member writes', MEMBER_MUTATION, MEMBER_WINDOW, MIRROR, 'pod.members.push(userId);', 'mirrorMemberAdded(a, b);'],
    ['pod creations', POD_CREATE, CREATE_WINDOW, MIRROR, 'await Pod.create({ name });', 'mirrorPodCreated(pod);'],
    ['User creations', USER_CREATE, USER_WINDOW, USER_MIRROR, 'await User.create({ name });', 'mirrorUser(user);'],
  ])('ends the window exactly for %s', (_name, patterns, window, mirror, write, call) => {
    const withGap = (gap) => scanSource([
      'async function join() {',
      `  ${write}`,
      ...Array.from({ length: gap }, () => '  step();'),
      `  ${call}`,
      '}',
    ].join('\n'), patterns, window, mirror);
    expect(withGap(window - 2)).toEqual([]);
    expect(withGap(window - 1)).toHaveLength(1);
  });

  it('reports a write outside any function, and pairs it with a mirror outside any function', () => {
    expect(flagged('pod.members.push(userId);\nstep();')).toHaveLength(1);
    expect(flagged('pod.members.push(userId);\nmirrorMemberAdded(podId, userId);')).toEqual([]);
    expect(flagged([
      'pod.members.push(userId);',
      'function join() {',
      '  return mirrorMemberAdded(podId, userId);',
      '}',
    ].join('\n'))).toHaveLength(1);
  });

  it('applies the same attribution to pod and User creations', () => {
    expect(scanSource([
      'const make = async (name) => {',
      '  return Pod.create({ name });',
      '};',
      'const sync = (podId: string,',
      '  name: string,',
      ') => mirrorPodCreated(podId, name);',
    ].join('\n'), POD_CREATE, CREATE_WINDOW)).toHaveLength(1);
    expect(scanSource([
      'const make = async (name) => {',
      '  const user = await User.create({ name });',
      '  const value = (',
      '    user.id',
      '  );',
      '  await mirrorUser(user);',
      '  return value;',
      '};',
    ].join('\n'), USER_CREATE, USER_WINDOW, USER_MIRROR)).toEqual([]);
  });

  it('accepts a real mirror call after the mutation', () => {
    expect(flagged([
      'async function join() {',
      '  pod.members.push(userId);',
      '  await mirrorMemberAdded(podId, userId);',
      '}',
    ].join('\n'))).toEqual([]);
  });
});

describe('PG mirror write sites (F183)', () => {
  it('every Mongo pod-member mutation writes the PG mirror or is allowed with a reason', () => {
    const missing = unmirrored(MEMBER_MUTATION, MEMBER_WINDOW).filter((key) => !ALLOWED[key]);
    expect(missing).toEqual([]);
  });

  it('every Mongo pod creation writes the PG mirror or is allowed with a reason', () => {
    const missing = unmirrored(POD_CREATE, CREATE_WINDOW).filter((key) => !ALLOWED[key]);
    expect(missing).toEqual([]);
  });

  // A User the mirror lacks renders as a nameless author in PG chat and counts
  // as missing in every diff until the nightly repair (2026-11-05: 130 rows).
  it('every Mongo User creation writes the PG users mirror or is allowed with a reason', () => {
    const missing = unmirrored(USER_CREATE, USER_WINDOW, USER_MIRROR).filter((key) => !ALLOWED[key]);
    expect(missing).toEqual([]);
  });

  it('carries no stale allowance', () => {
    const live = new Set([
      ...unmirrored(MEMBER_MUTATION, MEMBER_WINDOW),
      ...unmirrored(POD_CREATE, CREATE_WINDOW),
      ...unmirrored(USER_CREATE, USER_WINDOW, USER_MIRROR),
    ]);
    expect(Object.keys(ALLOWED).filter((key) => !live.has(key))).toEqual([]);
  });
});
