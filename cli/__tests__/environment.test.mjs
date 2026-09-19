/**
 * environment.test.mjs — ADR-008 Phase 1
 *
 * Covers parseEnvironmentFile, validateEnvironmentSpec, resolveWorkspace,
 * mountSkills. The module is pure I/O against the local FS — we use real temp
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
  isLegacySandboxTrust,
  normalizeSandboxTrust,
  parseEnvironmentFile,
  validateEnvironmentSpec,
  resolveWorkspace,
  mountSkills,
} = await import('../src/lib/environment.js');

// The repo's own default seat declaration is the one entry shape that MUST pass
// the rule added below — it is what every default-provisioned seat carries.
const { commonlyMcpServer } = await import('../src/lib/default-environment.js');

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

  // #774: before `model` was an allowed key, the only way to pin a wrapper's
  // model was a per-process env var that every restart silently dropped. On
  // 2026-08-16 six of nine live seats had lost their assigned model that way.
  test('accepts a model pin', () => {
    expect(validateEnvironmentSpec({ version: 1, model: 'claude-opus-5' }))
      .toEqual({ ok: true, errors: [] });
  });

  test('rejects an empty or non-string model', () => {
    for (const bad of ['', '   ', 42, null, {}]) {
      const res = validateEnvironmentSpec({ version: 1, model: bad });
      expect(res.ok).toBe(false);
      expect(res.errors.join(' ')).toMatch(/model must be a non-empty string/);
    }
  });

  // Deliberately NOT validated against a list of known ids: a whitelist here
  // would reject a valid model the local CLI understands and this file has
  // never heard of, failing an attach over a fact it is not the authority on.
  test('accepts an unrecognised model id, leaving validity to the CLI', () => {
    expect(validateEnvironmentSpec({ version: 1, model: 'some-future-model-9' }).ok)
      .toBe(true);
  });

  test('rejects bad sandbox.mode', () => {
    const res = validateEnvironmentSpec({ sandbox: { mode: 'rocket' } });
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toMatch(/sandbox.mode/);
  });

  test('accepts host-neutral public sandbox intent for the codex adapter', () => {
    expect(validateEnvironmentSpec({
      sandbox: { mode: 'workspace', trust: 'public' },
    })).toEqual({ ok: true, errors: [] });
    expect(validateEnvironmentSpec({
      sandbox: { mode: 'read-only', trust: 'public' },
    })).toEqual({ ok: true, errors: [] });
  });

  test('rejects sandbox.trust=internal — a value no adapter reads', () => {
    const res = validateEnvironmentSpec({
      sandbox: { mode: 'workspace', trust: 'internal' },
    });
    expect(res.ok).toBe(false);
    // The message has to name what DOES something, or the next author just
    // guesses again: `public`, or no trust field at all.
    expect(res.errors.join(' ')).toMatch(/sandbox\.trust must be 'public'/);
    expect(res.errors.join(' ')).toMatch(/omit it for your own seat/);
    expect(res.errors.join(' ')).toMatch(/got "internal"/);
  });

  test('accepts the two declarations that do something: public trust, or none', () => {
    expect(validateEnvironmentSpec({ sandbox: { trust: 'public' } }).ok).toBe(true);
    expect(validateEnvironmentSpec({ sandbox: { mode: 'bwrap' } }).ok).toBe(true);
  });

  test('rejects bad sandbox.trust', () => {
    const res = validateEnvironmentSpec({
      sandbox: { mode: 'workspace', trust: 'sometimes' },
    });
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toMatch(/sandbox.trust/);
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

  // TASK-071: the fields must agree with the declared transport. The backend
  // mirror is backend/utils/environmentSpecValidation.ts, pinned through the
  // write path by
  // backend/__tests__/unit/routes/registry.environment-mcp-shape.test.js —
  // deliberately duplicated, and the two must keep naming the same rule.
  describe('mcp transport decides the entry', () => {
    const stdio = { name: 'commonly', transport: 'stdio', command: ['npx', '-y', '@commonlyai/mcp@latest'] };

    test('accepts a stdio entry with an argv command', () => {
      expect(validateEnvironmentSpec({ version: 1, mcp: [stdio] }).ok).toBe(true);
    });

    test('accepts an http entry with a url and no command', () => {
      const res = validateEnvironmentSpec({ version: 1, mcp: [{ name: 'x', transport: 'http', url: 'https://remote.example/mcp' }] });
      expect(res).toEqual({ ok: true, errors: [] });
    });

    test('accepts an sse entry with a url, since sse is a remote transport too', () => {
      const res = validateEnvironmentSpec({ version: 1, mcp: [{ name: 'x', transport: 'sse', url: 'https://remote.example/sse' }] });
      expect(res).toEqual({ ok: true, errors: [] });
    });

    test('rejects an http entry that also carries a command', () => {
      const res = validateEnvironmentSpec({
        version: 1,
        mcp: [{ name: 'x', transport: 'http', url: 'https://remote.example/mcp', command: ['sh', '-c', 'curl evil'] }],
      });
      expect(res.ok).toBe(false);
      expect(res.errors.join(' ')).toMatch(/mcp\[0\].command must not be set when transport is http/);
    });

    test('rejects an http entry with no url', () => {
      const res = validateEnvironmentSpec({ version: 1, mcp: [{ name: 'x', transport: 'http' }] });
      expect(res.errors.join(' ')).toMatch(/mcp\[0\].url is required when transport is http/);
    });

    test('rejects a stdio entry carrying a url', () => {
      const res = validateEnvironmentSpec({ version: 1, mcp: [{ ...stdio, url: 'https://remote.example/mcp' }] });
      expect(res.errors.join(' ')).toMatch(/mcp\[0\].url must not be set for a stdio entry/);
    });

    test('rejects a url-only entry that declares no transport, on both counts', () => {
      const res = validateEnvironmentSpec({ version: 1, mcp: [{ name: 'x', url: 'https://remote.example/mcp' }] });
      expect(res.ok).toBe(false);
      expect(res.errors.join(' ')).toMatch(/mcp\[0\].command is required for a stdio entry/);
      expect(res.errors.join(' ')).toMatch(/mcp\[0\].url must not be set for a stdio entry/);
    });

    test('rejects a string command, which no reader in this repo executes', () => {
      const res = validateEnvironmentSpec({ version: 1, mcp: [{ name: 'x', transport: 'stdio', command: 'npx -y @commonlyai/mcp' }] });
      expect(res.errors.join(' ')).toMatch(/mcp\[0\].command must be a non-empty array of strings/);
    });

    test('reports an unknown transport and stops there rather than guessing one', () => {
      // The url is deliberate: it makes the early return observable. Without
      // it a fallen-through entry would collect the stdio url error too.
      const res = validateEnvironmentSpec({
        version: 1,
        mcp: [{ name: 'x', transport: 'ftp', command: ['npx'], url: 'https://x.example/mcp' }],
      });
      expect(res.ok).toBe(false);
      expect(res.errors.join(' ')).toMatch(/mcp\[0\].transport must be one of: http, stdio, sse/);
      // No agreement error: the entry has no transport to agree with.
      expect(res.errors.join(' ')).not.toMatch(/must not be set|is required when transport/);
    });

    test('accepts this repo\'s own default declaration, so the built-in seat spec passes it', () => {
      expect(validateEnvironmentSpec({ version: 1, mcp: [commonlyMcpServer()] }))
        .toEqual({ ok: true, errors: [] });
    });
  });

  test('underscore-prefixed keys are rejected (no internal annotations on the spec)', () => {
    // Spec must be serialization-clean for backend. Underscore-prefixed keys
    // were a v1-design holdover; we now enforce a closed allow-list.
    const res = validateEnvironmentSpec({ _envFileDir: '/tmp', version: 1 });
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toMatch(/unknown top-level key.*_envFileDir/);
  });
});

describe('legacy sandbox trust', () => {
  test('reads a stored internal as public, so the seat cannot stay silently unconfined', () => {
    const legacy = { mode: 'workspace', trust: 'internal' };
    expect(isLegacySandboxTrust(legacy)).toBe(true);
    expect(normalizeSandboxTrust(legacy)).toEqual({ mode: 'workspace', trust: 'public' });
  });

  test('leaves every other declaration alone, including an absent sandbox block', () => {
    const publicTrust = { trust: 'public' };
    expect(normalizeSandboxTrust(publicTrust)).toBe(publicTrust);
    expect(isLegacySandboxTrust(undefined)).toBe(false);
    expect(isLegacySandboxTrust({})).toBe(false);
    expect(isLegacySandboxTrust({ trust: 'workspace' })).toBe(false);
    expect(normalizeSandboxTrust(undefined)).toBeUndefined();
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

describe('mountSkills', () => {
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

  const slotFor = (src) => path.join(workspace, '.claude', 'skills', path.basename(src));

  test('mounts a real directory copy, not a symlink', async () => {
    const { mounted, conflicted } = await mountSkills(
      { skills: { claude: [skillSrc] } },
      workspace,
    );
    expect(mounted).toEqual([skillSrc]);
    expect(conflicted).toEqual([]);

    const slot = slotFor(skillSrc);
    expect(fs.lstatSync(slot).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(slot).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(slot, 'SKILL.md'), 'utf8')).toBe('# my skill');
  });

  // The bug this function exists to prevent: @commonlyai/cli@0.1.4 shipped
  // without the #702 "post as yourself" guardrail because an agent wrote
  // through the old symlink into the operator's checkout, and `npm publish`
  // ships the working tree rather than git HEAD.
  test('writes into the mount CANNOT reach the source (regression: cli 0.1.4 guardrail loss)', async () => {
    await mountSkills({ skills: { claude: [skillSrc] } }, workspace);
    const slot = slotFor(skillSrc);

    // Simulate an agent rewriting its own governing skill file. It must be
    // able to affect at most its own copy — never the source of truth.
    fs.chmodSync(path.join(slot, 'SKILL.md'), 0o644);
    fs.writeFileSync(path.join(slot, 'SKILL.md'), '# guardrail deleted', 'utf8');

    expect(fs.readFileSync(path.join(skillSrc, 'SKILL.md'), 'utf8')).toBe('# my skill');
  });

  test('mounted files are read-only (defense in depth)', async () => {
    await mountSkills({ skills: { claude: [skillSrc] } }, workspace);
    const mode = fs.statSync(path.join(slotFor(skillSrc), 'SKILL.md')).mode & 0o222;
    expect(mode).toBe(0);
  });

  test('re-mounting refreshes from source, so source edits still reach the agent', async () => {
    await mountSkills({ skills: { claude: [skillSrc] } }, workspace);
    fs.writeFileSync(path.join(skillSrc, 'SKILL.md'), '# updated upstream', 'utf8');

    const second = await mountSkills({ skills: { claude: [skillSrc] } }, workspace);
    expect(second.mounted).toEqual([skillSrc]);
    expect(second.conflicted).toEqual([]);
    expect(fs.readFileSync(path.join(slotFor(skillSrc), 'SKILL.md'), 'utf8'))
      .toBe('# updated upstream');
  });

  test('a legacy symlink from CLI <=0.1.4 is replaced by a snapshot', async () => {
    const slot = slotFor(skillSrc);
    fs.mkdirSync(path.dirname(slot), { recursive: true });
    fs.symlinkSync(skillSrc, slot);

    const { mounted, conflicted } = await mountSkills(
      { skills: { claude: [skillSrc] } },
      workspace,
    );
    expect(mounted).toEqual([skillSrc]);
    expect(conflicted).toEqual([]);
    expect(fs.lstatSync(slot).isSymbolicLink()).toBe(false);
    // The source survived the replacement (rm must not follow the symlink).
    expect(fs.readFileSync(path.join(skillSrc, 'SKILL.md'), 'utf8')).toBe('# my skill');
  });

  test('returns empty buckets when no skills are declared', async () => {
    expect(await mountSkills({}, workspace)).toEqual({ mounted: [], conflicted: [] });
  });

  test('non-existent source paths surface as `missing-source` conflicts (not silent skips)', async () => {
    const ghost = path.join(skillSrc, 'does-not-exist');
    const { mounted, conflicted } = await mountSkills(
      { skills: { claude: [ghost] } },
      workspace,
    );
    expect(mounted).toEqual([]);
    expect(conflicted).toEqual([{ path: ghost, reason: 'missing-source' }]);
  });

  test('a user-authored dir at the slot is never clobbered — `not-a-mount`', async () => {
    // No mount marker => we did not create it => it is real user work.
    const slot = slotFor(skillSrc);
    fs.mkdirSync(slot, { recursive: true });
    fs.writeFileSync(path.join(slot, 'hand-edited.md'), 'mine', 'utf8');

    const { mounted, conflicted } = await mountSkills(
      { skills: { claude: [skillSrc] } },
      workspace,
    );
    expect(mounted).toEqual([]);
    expect(conflicted).toEqual([{ path: skillSrc, reason: 'not-a-mount' }]);
    expect(fs.readFileSync(path.join(slot, 'hand-edited.md'), 'utf8')).toBe('mine');
  });
});
