/**
 * environment.test.mjs — ADR-008 Phase 1
 *
 * Covers parseEnvironmentFile, validateEnvironmentSpec, resolveWorkspace,
 * linkSkills. The module is pure I/O against the local FS — we use real temp
 * dirs and a mocked `os.homedir` so `~` expansion and the default workspace
 * path land somewhere disposable.
 */

import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-env-test-'));

await jest.unstable_mockModule('os', () => {
  const actual = os;
  return {
    ...actual,
    default: { ...actual, homedir: () => tmpHome },
    homedir: () => tmpHome,
  };
});

const {
  parseEnvironmentFile,
  validateEnvironmentSpec,
  resolveWorkspace,
  linkSkills,
} = await import('../src/lib/environment.js');

const writeJson = (dir, name, obj) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
  return file;
};

describe('parseEnvironmentFile', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-env-parse-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('parses a valid JSON env file and returns the bare spec', async () => {
    const file = writeJson(dir, 'env.json', {
      version: 1,
      workspace: { path: '~/projects/foo' },
      sandbox: { mode: 'bwrap' },
    });
    const spec = await parseEnvironmentFile(file);
    expect(spec.version).toBe(1);
    expect(spec.workspace.path).toBe('~/projects/foo');
    // Spec must NOT carry envFileDir / _envFileDir — that path is host-private
    // and would leak to the backend on `config.environment` install POST.
    expect(spec._envFileDir).toBeUndefined();
    expect(spec.envFileDir).toBeUndefined();
  });

  test('rejects YAML files in Phase 1 with a JSON-conversion hint', async () => {
    const file = path.join(dir, 'env.yaml');
    fs.writeFileSync(file, 'version: 1\n', 'utf8');
    await expect(parseEnvironmentFile(file)).rejects.toThrow(
      /YAML environment files are not supported.*JSON/s,
    );
  });

  test('rejects malformed JSON with the file path in the error', async () => {
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, '{ not-json', 'utf8');
    await expect(parseEnvironmentFile(file)).rejects.toThrow(/Failed to parse/);
  });

  test('surfaces validation errors before returning', async () => {
    const file = writeJson(dir, 'env.json', {
      version: 99, sandbox: { mode: 'unknown-mode' },
    });
    await expect(parseEnvironmentFile(file)).rejects.toThrow(
      /version must be 1|sandbox.mode must be/,
    );
  });

  test('rejects relative paths (callers must resolve first)', async () => {
    await expect(parseEnvironmentFile('env.json')).rejects.toThrow(
      /requires an absolute path/,
    );
  });
});

describe('validateEnvironmentSpec', () => {
  test('accepts a minimal valid spec', () => {
    expect(validateEnvironmentSpec({ version: 1 })).toEqual({ ok: true, errors: [] });
  });

  test('rejects unknown top-level keys', () => {
    const res = validateEnvironmentSpec({ version: 1, sandbax: {} });
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toMatch(/unknown top-level key.*sandbax/);
  });

  test('rejects bad sandbox.mode', () => {
    const res = validateEnvironmentSpec({ sandbox: { mode: 'rocket' } });
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toMatch(/sandbox.mode/);
  });

  test('rejects bad sandbox.network.policy', () => {
    const res = validateEnvironmentSpec({
      sandbox: { network: { policy: 'kinda-restricted' } },
    });
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toMatch(/network.policy/);
  });

  test('rejects skills.claude that is not an array of strings', () => {
    const res = validateEnvironmentSpec({ skills: { claude: 'not-an-array' } });
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toMatch(/skills.claude/);
  });

  test('mcp entries require name; flag missing-name with index', () => {
    const res = validateEnvironmentSpec({ mcp: [{ transport: 'http' }] });
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toMatch(/mcp\[0\].name/);
  });

  test('underscore-prefixed keys are rejected (no internal annotations on the spec)', () => {
    // Spec must be serialization-clean for backend. Underscore-prefixed keys
    // were a v1-design holdover; we now enforce a closed allow-list.
    const res = validateEnvironmentSpec({ _envFileDir: '/tmp', version: 1 });
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toMatch(/unknown top-level key.*_envFileDir/);
  });
});

describe('resolveWorkspace', () => {
  test('expands ~ and creates the workspace dir; reports created=true', async () => {
    const spec = { workspace: { path: '~/projects/sandbox-research' } };
    const { path: ws, created } = await resolveWorkspace(spec, 'research');
    expect(ws).toBe(path.join(tmpHome, 'projects', 'sandbox-research'));
    expect(created).toBe(true);
    expect(fs.existsSync(ws)).toBe(true);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  test('defaults to ~/.commonly/workspaces/<agent> when workspace.path absent', async () => {
    const { path: ws, created } = await resolveWorkspace({}, 'liz');
    expect(ws).toBe(path.join(tmpHome, '.commonly', 'workspaces', 'liz'));
    expect(created).toBe(true);
    expect(fs.existsSync(ws)).toBe(true);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  test('reports created=false when workspace already exists', async () => {
    const ws = path.join(tmpHome, 'preexisting-ws');
    fs.mkdirSync(ws, { recursive: true });
    const { path: out, created } = await resolveWorkspace({ workspace: { path: ws } }, 'x');
    expect(out).toBe(ws);
    expect(created).toBe(false);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  test('copies seed paths into a freshly-created workspace', async () => {
    const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-env-seed-'));
    fs.writeFileSync(path.join(envDir, 'README.md'), '# seed', 'utf8');
    fs.mkdirSync(path.join(envDir, 'prompts'));
    fs.writeFileSync(path.join(envDir, 'prompts', 'a.txt'), 'hi', 'utf8');

    const wsTarget = path.join(tmpHome, 'seeded-ws');
    const { path: ws } = await resolveWorkspace(
      { workspace: { path: wsTarget, seed: ['./README.md', './prompts'] } },
      'seeded',
      envDir, // envFileDir as a separate arg, not embedded in the spec
    );
    expect(fs.existsSync(path.join(ws, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(ws, 'prompts', 'a.txt'))).toBe(true);

    fs.rmSync(envDir, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  });
});

describe('linkSkills', () => {
  let workspace;
  let skillSrc;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-env-ws-'));
    skillSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-env-skill-'));
    fs.writeFileSync(path.join(skillSrc, 'SKILL.md'), '# my skill', 'utf8');
  });
  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(skillSrc, { recursive: true, force: true });
  });

  test('creates .claude/skills/<basename> symlink to the source dir', async () => {
    const { linked, skipped, conflicted } = await linkSkills(
      { skills: { claude: [skillSrc] } },
      workspace,
    );
    expect(linked).toEqual([skillSrc]);
    expect(skipped).toEqual([]);
    expect(conflicted).toEqual([]);

    const linkPath = path.join(workspace, '.claude', 'skills', path.basename(skillSrc));
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(linkPath, 'SKILL.md'), 'utf8')).toBe('# my skill');
  });

  test('idempotent: re-running with the same source reports as already-linked', async () => {
    await linkSkills({ skills: { claude: [skillSrc] } }, workspace);
    const second = await linkSkills({ skills: { claude: [skillSrc] } }, workspace);
    expect(second.linked).toEqual([]);
    expect(second.skipped).toEqual([skillSrc]);
    expect(second.conflicted).toEqual([]);
  });

  test('refuses to overwrite a different existing symlink at the same slot — reports `different-target`', async () => {
    // Two different source dirs, same basename — second one must surface as
    // a conflict so the caller can warn the user (NOT silently merged into
    // skipped, which would mask the user's intent being lost).
    const otherSrc = fs.mkdtempSync(path.join(path.dirname(skillSrc),
      `${path.basename(skillSrc).slice(0, -6)}-X-`));
    const slotName = path.basename(skillSrc);
    const slotPath = path.join(workspace, '.claude', 'skills', slotName);
    fs.mkdirSync(path.dirname(slotPath), { recursive: true });
    fs.symlinkSync(otherSrc, slotPath);

    const { linked, skipped, conflicted } = await linkSkills(
      { skills: { claude: [skillSrc] } },
      workspace,
    );
    expect(linked).toEqual([]);
    expect(skipped).toEqual([]);
    expect(conflicted).toEqual([{ path: skillSrc, reason: 'different-target' }]);
    // Existing link untouched.
    expect(fs.readlinkSync(slotPath)).toBe(otherSrc);

    fs.rmSync(otherSrc, { recursive: true, force: true });
  });

  test('returns empty buckets when no skills are declared', async () => {
    expect(await linkSkills({}, workspace)).toEqual({
      linked: [], skipped: [], conflicted: [],
    });
  });

  test('non-existent source paths surface as `missing-source` conflicts (not silent skips)', async () => {
    const ghost = path.join(skillSrc, 'does-not-exist');
    const { linked, skipped, conflicted } = await linkSkills(
      { skills: { claude: [ghost] } },
      workspace,
    );
    expect(linked).toEqual([]);
    expect(skipped).toEqual([]);
    expect(conflicted).toEqual([{ path: ghost, reason: 'missing-source' }]);
  });

  test('non-symlink occupants (real files/dirs) surface as `not-symlink` conflicts', async () => {
    // A user might have hand-created a real dir at the slot — never overwrite.
    const slotName = path.basename(skillSrc);
    const slotPath = path.join(workspace, '.claude', 'skills', slotName);
    fs.mkdirSync(path.dirname(slotPath), { recursive: true });
    fs.mkdirSync(slotPath);
    fs.writeFileSync(path.join(slotPath, 'hand-edited.md'), 'mine', 'utf8');

    const { linked, skipped, conflicted } = await linkSkills(
      { skills: { claude: [skillSrc] } },
      workspace,
    );
    expect(linked).toEqual([]);
    expect(skipped).toEqual([]);
    expect(conflicted).toEqual([{ path: skillSrc, reason: 'not-symlink' }]);
    // Hand-edited file untouched.
    expect(fs.existsSync(path.join(slotPath, 'hand-edited.md'))).toBe(true);
  });
});
