/**
 * The realpath a workspace-trust seat's folder had when the seat first ran
 * there (F200).
 *
 * A public seat's writable folder is pinned to its own name (seatbelt.js
 * pinnedRealpath, F197). A workspace seat's folder is the operator's choice
 * and may be a link on purpose, so it cannot be pinned that way. But a seat
 * with write access can remove its project folder and leave a link in its
 * place, and the next turn's grant (a Seatbelt subpath on the resolved path,
 * or a bwrap bind of it) would follow that link.
 *
 * So the folder's realpath is recorded the first time the seat runs there,
 * and a later turn whose folder resolves anywhere else is refused before
 * anything is spawned. A link the operator had in place before that first
 * turn is part of what was recorded and keeps working. The record lives in a
 * folder beside the seat's state folder, which no turn is granted: Seatbelt
 * denies writes to it by name, and bwrap never binds it. A workspace that
 * contains it is refused.
 *
 * Each folder has its own record file, created once and never rewritten: a
 * staged copy is hard-linked to the final name, which fails if the name is
 * taken. So two turns recording at once cannot lose each other's record, and
 * two that disagree about one folder cannot both pass.
 *
 * Recording happens on the first turn, not at attach: attach does not know
 * the seat's state folder, and no turn of the seat runs between attach and its
 * first turn. A seat that already ran before this check existed is recorded on
 * its first turn after the update.
 */
import {
  link, lstat, mkdir, readFile, realpath, rm, writeFile,
} from 'fs/promises';
import { createHash, randomUUID } from 'crypto';
import {
  basename, dirname, isAbsolute, join, relative, resolve, sep,
} from 'path';

export const workspacePinDir = (statePath) => join(dirname(statePath), 'workspace-pins');
export const workspacePinFile = (statePath, cwd) => {
  const folder = createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 16);
  return join(workspacePinDir(statePath), `${basename(statePath)}-${folder}.json`);
};

const isInsideOrEqual = (child, parent) => {
  const rel = relative(parent, child);
  return rel === '' || (rel.split(sep)[0] !== '..' && !isAbsolute(rel));
};

const readRecord = async (file) => {
  let stat;
  try {
    stat = await lstat(file);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  const unreadable = (why) => new Error(
    `refusing a workspace turn: this agent's workspace record ${file} ${why}. `
    + 'First confirm the agent\'s folder resolves where you expect (for example with `realpath`), '
    + 'then remove the record; the next turn records the folder as it resolves then.',
  );
  if (!stat.isFile()) throw unreadable('is not a regular file');
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (typeof parsed?.realpath !== 'string' || !parsed.realpath) throw new Error('bad shape');
    return parsed;
  } catch {
    throw unreadable('cannot be read');
  }
};

// True when this call created the record, false when another had already. The
// final name appears only complete, because it is a link to a finished copy.
const createRecord = async (file, record, { _writeFile = writeFile } = {}) => {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const staged = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  try {
    await _writeFile(staged, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await link(staged, file);
    return true;
  } catch (err) {
    if (err?.code === 'EEXIST') return false;
    throw err;
  } finally {
    await rm(staged, { force: true });
  }
};

const changed = ({ given, current, recorded, file }) => new Error(
  `refusing a workspace turn: ${given} now resolves to ${current}, but it resolved to `
  + `${recorded} when this agent first ran there. A turn can replace its folder with a `
  + 'link, which would let the next turn write wherever the link points. If you moved the '
  + `project on purpose, remove ${file} (the next turn records the new location), or attach `
  + 'the agent to the project\'s new folder.',
);

/**
 * Compare the folder's realpath with the one recorded for it, recording it
 * when there is none, and return the realpath to grant. A folder that does not
 * resolve is refused, recorded or not: the run loop makes the folder before
 * each turn, so there is nothing here to grant.
 *
 * `_realpath` and `_writeFile` are test seams.
 */
export const holdWorkspaceRealpath = async ({
  cwd, statePath, log = (line) => console.warn(line), _realpath = realpath, _writeFile = writeFile,
}) => {
  const given = resolve(cwd);
  const file = workspacePinFile(statePath, given);
  let current;
  try {
    current = await _realpath(given);
  } catch {
    // Missing, or a link to nowhere.
    const entry = await readRecord(file);
    if (entry) throw changed({ given, current: 'nothing', recorded: entry.realpath, file });
    throw new Error(
      `refusing a workspace turn: ${given} does not resolve to a folder. `
      + 'Create the folder or point the agent at one, and run the turn again.',
    );
  }
  const pinDir = workspacePinDir(statePath);
  let realPinDir = pinDir;
  try {
    realPinDir = await realpath(pinDir);
  } catch {
    try {
      realPinDir = join(await realpath(dirname(pinDir)), basename(pinDir));
    } catch {
      // Neither exists yet; compared as given.
    }
  }
  if (isInsideOrEqual(realPinDir, current)) {
    throw new Error(
      `refusing a workspace turn: ${given} contains this agent's own record of its folder (${pinDir}), `
      + 'which the agent must not be able to write. Point the agent at a project folder instead.',
    );
  }
  const held = async (entry) => {
    if (entry?.realpath !== current) {
      throw changed({ given, current, recorded: entry?.realpath ?? 'nothing', file });
    }
    return current;
  };
  const existing = await readRecord(file);
  if (existing) return held(existing);
  const created = await createRecord(file, {
    workspace: given, realpath: current, recordedAt: new Date().toISOString(),
  }, { _writeFile });
  // Another turn recorded it first: this turn answers to that record.
  if (!created) return held(await readRecord(file));
  // Once per folder: a seat that ran before this check is recorded as its
  // folder resolves now, which the operator should confirm.
  log(`[claude] workspace: recorded ${given} → ${current}`);
  return current;
};

export default { holdWorkspaceRealpath, workspacePinDir, workspacePinFile };
