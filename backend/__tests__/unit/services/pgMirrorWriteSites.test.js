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
  /\$addToSet:\s*\{\s*members\b/,
  /\$push:\s*\{\s*members\b/,
  /\$pull:\s*\{\s*members\b/,
  /\.members\.push\(/,
  /\.members\s*=(?!=)/,
];
const POD_CREATE = [/\bPod\.create\(/, /\bnew Pod\(/];
const USER_CREATE = [/\bUser\.create\(/, /\bnew User\(/, /\bUser\.insertMany\(/];
const USER_WINDOW = 40;
const FUNCTION_START = /^(\s{2}(static\s+)?(async\s+)?[a-zA-Z_]+\s*\([^)]*\)[^;]*\{\s*$|(export\s+)?(async\s+)?function\b|(export\s+)?const\s+\w+\s*=\s*async\b|exports\.\w+\s*=|router\.(get|post|put|patch|delete)\()/;
const MIRROR = /mirrorMember(Added|Removed)|mirrorPodCreated|syncPgDmMembers|syncPodFromMongo|PGPod\.(addMember|removeMember|create)|pod_members|ensureGlobalPodPostgresSync/;
const USER_MIRROR = /mirrorUser\(|syncUserToPostgreSQL\(/;

// `file: the source text of the mutation line, trimmed` → why it may lag PG.
const ALLOWED = {
  'services/accountDeletionService.ts: { $pull: { members: userId } });':
    'Mirrored in the same deletion flow by anonymizeChatAuthor, a separate function'
    + ' (DELETE FROM pod_members for the non-DM pods this $pull covers).',
};

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return entry.name === '__tests__' ? [] : walk(full);
  return entry.name.endsWith('.ts') ? [full] : [];
});

const unmirrored = (patterns, window, mirror = MIRROR) => {
  const found = [];
  for (const dir of DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;
        if (/PGPod|pg\/Pod/.test(line)) return;
        if (!patterns.some((re) => re.test(line))) return;
        // The window ends at the next function boundary, so a mirror write in
        // the following method cannot vouch for this one.
        const tail = lines.slice(i + 1, i + window);
        const end = tail.findIndex((l) => FUNCTION_START.test(l));
        const after = [line, ...(end === -1 ? tail : tail.slice(0, end))].join('\n');
        if (mirror.test(after)) return;
        found.push(`${path.relative(ROOT, file)}: ${line.trim()}`);
      });
    }
  }
  return found;
};

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
