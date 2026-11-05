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
 * Detection is textual and deliberately coarse: a mutation counts as mirrored
 * when a mirror write appears within WINDOW lines after it. That is weaker than
 * a behaviour test, so every wired site also has one (pgMirrorWrite.test.js,
 * podController.pgMirror.test.js, pods.rename.test.js). Adding a site to
 * ALLOWED is a decision: say why the mirror may lag.
 */
const fs = require('fs');
const path = require('path');

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
const FUNCTION_START = /^(\s{2}(static\s+)?(async\s+)?[a-zA-Z_]+\s*\([^)]*\)[^;]*\{\s*$|(export\s+)?(async\s+)?function\b|(export\s+)?const\s+\w+\s*=\s*async\b|^\s*(export\s+)?(const|let)\s+\w+\s*=\s*(async\s+)?(\([^)]*\)|\w+)\s*(:[^=]*)?=>|exports\.\w+\s*=|router\.(get|post|put|patch|delete)\()/;
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

// Patterns match across newlines (`\s*` spans them), so a mutation split over
// lines is caught at the line it starts on. A mirror call only counts when it
// is code, never when it is a comment.
const scanSource = (text, patterns, window, mirror = MIRROR) => {
  const code = stripComments(text);
  const lines = code.split('\n');
  const starts = new Set();
  patterns.forEach((re) => {
    const global = new RegExp(re.source, 'g');
    let m = global.exec(code);
    while (m) {
      starts.add(code.slice(0, m.index).split('\n').length - 1);
      m = global.exec(code);
    }
  });
  const hits = [];
  [...starts].sort((a, b) => a - b).forEach((i) => {
    const line = lines[i];
    if (/PGPod|pg\/Pod/.test(line)) return;
    // The window ends at the next function boundary, so a mirror write in
    // the following method cannot vouch for this one.
    const tail = lines.slice(i + 1, i + window);
    const end = tail.findIndex((l) => FUNCTION_START.test(l));
    const after = [line, ...(end === -1 ? tail : tail.slice(0, end))].join('\n');
    if (mirror.test(after)) return;
    hits.push(line.trim());
  });
  return hits;
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
    expect(flagged([
      'export const leave = async (pod: Pod, userId: string): Promise<void> => {',
      '  pod.members.push(userId);',
      '};',
      'export const join = async (podId: string): Promise<boolean> => mirrorMemberAdded(podId, u);',
    ].join('\n'))).toHaveLength(1);
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
