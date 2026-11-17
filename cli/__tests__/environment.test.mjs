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
  environmentForServer,
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

  test('accepts an OpenCode external provider with a host-local key file', () => {
    expect(validateEnvironmentSpec({
      model: 'gpt-5.4',
      provider: {
        id: 'litellm',
        baseURL: 'https://llm.example.test/v1',
        keyFile: '/Users/kai/.config/commonly/llm-key',
        models: { 'gpt-5.4': { name: 'GPT 5.4' } },
      },
    })).toEqual({ ok: true, errors: [] });
  });

  test('rejects unsafe provider declarations and a qualified model id', () => {
    const invalid = [
      { id: 'bad/id', baseURL: 'https://llm.example.test/v1', keyFile: '/tmp/key' },
      { id: 'litellm', baseURL: 'https://user:pass@llm.example.test/v1', keyFile: '/tmp/key' },
      { id: 'litellm', baseURL: 'https://llm.example.test/v1?token=x', keyFile: '/tmp/key' },
      { id: 'litellm', baseURL: 'file:///tmp/provider', keyFile: '/tmp/key' },
      { id: 'litellm', baseURL: 'https://llm.example.test/v1', keyFile: 'relative/key' },
      {
        id: 'litellm', baseURL: 'https://llm.example.test/v1', keyFile: '/tmp/key',
        models: { 'gpt/5.4': { name: 'bad id' } },
      },
      {
        id: 'litellm', baseURL: 'https://llm.example.test/v1', keyFile: '/tmp/key',
        apiKey: 'inline-secret',
      },
      {
        id: 'litellm', baseURL: 'https://llm.example.test/v1', keyFile: '/tmp/key',
        models: { 'gpt-5.4': { options: { apiKey: 'inline-secret' } } },
      },
      {
        id: 'litellm', baseURL: 'https://llm.example.test/v1', keyFile: '/tmp/key',
        models: { 'gpt-5.4': { options: { clientSecret: 'inline-secret' } } },
      },
    ];
    for (const provider of invalid) {
      expect(validateEnvironmentSpec({ model: 'gpt-5.4', provider }).ok).toBe(false);
    }
    expect(validateEnvironmentSpec({
      model: 'litellm/gpt-5.4',
      provider: { id: 'litellm', baseURL: 'https://llm.example.test/v1', keyFile: '/tmp/key' },
    }).ok).toBe(false);
    expect(validateEnvironmentSpec({
      provider: { id: 'litellm', baseURL: 'https://llm.example.test/v1', keyFile: '/tmp/key' },
    }).errors.join(' ')).toMatch(/model is required/);
  });

  test('omits the complete host-local provider block from registry environment payloads', () => {
    const environment = {
      model: 'gpt-5.4',
      provider: {
        id: 'litellm', baseURL: 'https://llm.example.test/v1',
        keyFile: '/Users/kai/.config/commonly/llm-key',
      },
    };
    expect(environmentForServer(environment)).toEqual({
      model: 'gpt-5.4',
    });
    expect(environment.provider).toEqual({
      id: 'litellm',
      baseURL: 'https://llm.example.test/v1',
      keyFile: '/Users/kai/.config/commonly/llm-key',
    });
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
    // guesses again: `public`, `workspace`, or no trust field at all.
    expect(res.errors.join(' ')).toMatch(/sandbox\.trust must be 'public' or 'workspace'/);
    expect(res.errors.join(' ')).toMatch(/omit it for an unconfined seat of your own/);
    expect(res.errors.join(' ')).toMatch(/got "internal"/);
  });

  test('accepts the declarations that do something: public, workspace, or none', () => {
    expect(validateEnvironmentSpec({ sandbox: { trust: 'public' } }).ok).toBe(true);
    expect(validateEnvironmentSpec({ sandbox: { trust: 'workspace' } }).ok).toBe(true);
    expect(validateEnvironmentSpec({ sandbox: { mode: 'bwrap' } }).ok).toBe(true);
  });

  test('accepts the workspace opt-ins, and only on a workspace seat', () => {
    expect(validateEnvironmentSpec({
      sandbox: { trust: 'workspace', allow: ['write', 'web'] },
    })).toEqual({ ok: true, errors: [] });
    const onPublic = validateEnvironmentSpec({ sandbox: { trust: 'public', allow: ['write'] } });
    expect(onPublic.ok).toBe(false);
    expect(onPublic.errors.join(' ')).toMatch(/sandbox\.allow applies only to trust 'workspace'/);
    const unknown = validateEnvironmentSpec({ sandbox: { trust: 'workspace', allow: ['search'] } });
    expect(unknown.ok).toBe(false);
    expect(unknown.errors.join(' ')).toMatch(/sandbox\.allow must be an array of: write, web/);
  });

  test('refuses a write grant on a read-only seat rather than let the jail quietly drop it', () => {
    const result = validateEnvironmentSpec({
      sandbox: { mode: 'read-only', trust: 'workspace', allow: ['write'] },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/sandbox\.allow 'write' cannot be combined with sandbox\.mode 'read-only'/);
    expect(validateEnvironmentSpec({
      sandbox: { mode: 'read-only', trust: 'workspace', allow: ['web'] },
    }).ok).toBe(true);
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

// F171: skills are written only into a real .claude/skills directory. Each
// component is checked with lstat and never followed; a link, or anything that
// is not a real directory, gets no mount, and none of the write steps (mkdir,
// the refresh, the copy, the marker, the read-only pass) runs.
describe('mountSkills refuses a linked .claude or .claude/skills (F171)', () => {
  let root;
  let workspace;
  let outside;
  let skillSrc;
  let name;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-env-f171-'));
    workspace = path.join(root, 'ws');
    outside = path.join(root, 'outside');
    skillSrc = path.join(root, 'src', 'my-skill');
    fs.mkdirSync(workspace);
    fs.mkdirSync(outside);
    fs.mkdirSync(skillSrc, { recursive: true });
    fs.writeFileSync(path.join(skillSrc, 'SKILL.md'), '# my skill', 'utf8');
    name = path.basename(skillSrc);
  });
  afterEach(() => {
    // Restore write bits so cleanup works whatever a run left read-only.
    const thaw = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) thaw(full);
        else if (e.isFile()) fs.chmodSync(full, 0o644);
      }
    };
    thaw(root);
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Every entry under dir, read with lstat so a link is recorded, not followed.
  const snapshot = (dir) => {
    const out = [];
    const walk = (d, rel) => {
      for (const e of fs.readdirSync(d).sort()) {
        const full = path.join(d, e);
        const r = path.join(rel, e);
        const st = fs.lstatSync(full);
        if (st.isSymbolicLink()) out.push([r, 'link', fs.readlinkSync(full)]);
        else if (st.isDirectory()) { out.push([r, 'dir', st.mode & 0o777]); walk(full, r); }
        else out.push([r, 'file', st.mode & 0o777, fs.readFileSync(full, 'utf8')]);
      }
    };
    walk(dir, '');
    return out;
  };

  // Where each layout's link points, and the path under that target that
  // corresponds to the skill slot.
  const layouts = {
    '.claude links outside the workspace': () => {
      fs.symlinkSync(outside, path.join(workspace, '.claude'));
      return { target: outside, slotUnder: path.join(outside, 'skills', name) };
    },
    '.claude/skills links outside the workspace': () => {
      fs.mkdirSync(path.join(workspace, '.claude'));
      fs.symlinkSync(outside, path.join(workspace, '.claude', 'skills'));
      return { target: outside, slotUnder: path.join(outside, name) };
    },
    '.claude links elsewhere inside the workspace': () => {
      const inside = path.join(workspace, 'notes');
      fs.mkdirSync(inside);
      fs.symlinkSync(inside, path.join(workspace, '.claude'));
      return { target: inside, slotUnder: path.join(inside, 'skills', name) };
    },
    '.claude/skills links elsewhere inside the workspace': () => {
      const inside = path.join(workspace, 'notes');
      fs.mkdirSync(inside);
      fs.mkdirSync(path.join(workspace, '.claude'));
      fs.symlinkSync(inside, path.join(workspace, '.claude', 'skills'));
      return { target: inside, slotUnder: path.join(inside, name) };
    },
    '.claude is a relative link that climbs out': () => {
      fs.symlinkSync(path.join('..', 'outside'), path.join(workspace, '.claude'));
      return { target: outside, slotUnder: path.join(outside, 'skills', name) };
    },
  };
  const cases = Object.keys(layouts);

  const mount = () => mountSkills({ skills: { claude: [skillSrc] } }, workspace);
  const refused = () => ({ mounted: [], conflicted: [{ path: skillSrc, reason: 'unsafe-skill-dir' }] });

  // The mkdir step: nothing is created anywhere, and the link stays a link.
  test.each(cases)('mkdir step: %s; the mount is refused and nothing is created', async (layout) => {
    layouts[layout]();
    const outsideBefore = snapshot(outside);
    const workspaceBefore = snapshot(workspace);

    expect(await mount()).toEqual(refused());

    expect(snapshot(outside)).toEqual(outsideBefore);
    expect(snapshot(workspace)).toEqual(workspaceBefore);
  });

  // The refresh step: a marked directory at the link target is left as it was.
  test.each(cases)('refresh step: %s; a marked directory at the target is left as it was', async (layout) => {
    const { slotUnder } = layouts[layout]();
    fs.mkdirSync(slotUnder, { recursive: true });
    fs.writeFileSync(path.join(slotUnder, '.commonly-skill-mount'), 'mounted-from: elsewhere\n');
    fs.writeFileSync(path.join(slotUnder, 'keep.txt'), 'real work');

    expect(await mount()).toEqual(refused());

    expect(fs.readFileSync(path.join(slotUnder, 'keep.txt'), 'utf8')).toBe('real work');
  });

  // The copy, marker and read-only steps: nothing at the link target changes.
  test.each(cases)('copy, marker and read-only steps: %s; nothing at the target changes', async (layout) => {
    const { target, slotUnder } = layouts[layout]();
    fs.mkdirSync(slotUnder, { recursive: true });
    fs.writeFileSync(path.join(slotUnder, '.commonly-skill-mount'), 'mounted-from: elsewhere\n');
    fs.writeFileSync(path.join(slotUnder, 'keep.txt'), 'real work');
    fs.chmodSync(path.join(slotUnder, 'keep.txt'), 0o644);
    const before = snapshot(target);

    expect(await mount()).toEqual(refused());

    expect(snapshot(target)).toEqual(before);
    expect(fs.existsSync(path.join(slotUnder, 'SKILL.md'))).toBe(false);
    expect(fs.readFileSync(path.join(slotUnder, '.commonly-skill-mount'), 'utf8')).toBe('mounted-from: elsewhere\n');
    expect(fs.statSync(path.join(slotUnder, 'keep.txt')).mode & 0o777).toBe(0o644);
  });

  test('a dangling .claude link is refused, and nothing is created at its target', async () => {
    const missing = path.join(outside, 'not-yet');
    fs.symlinkSync(missing, path.join(workspace, '.claude'));

    expect(await mount()).toEqual(refused());

    expect(fs.existsSync(missing)).toBe(false);
  });

  test.each(['.claude', path.join('.claude', 'skills')])('a regular file at %s is refused and left as it was', async (rel) => {
    fs.mkdirSync(path.dirname(path.join(workspace, rel)), { recursive: true });
    fs.writeFileSync(path.join(workspace, rel), 'not a dir');

    expect(await mount()).toEqual(refused());

    expect(fs.readFileSync(path.join(workspace, rel), 'utf8')).toBe('not a dir');
  });

  test('every declared source is reported, and none is written', async () => {
    const second = path.join(root, 'src', 'other-skill');
    fs.mkdirSync(second);
    fs.writeFileSync(path.join(second, 'SKILL.md'), '# other');
    fs.symlinkSync(outside, path.join(workspace, '.claude'));

    const result = await mountSkills({ skills: { claude: [skillSrc, second] } }, workspace);

    expect(result).toEqual({
      mounted: [],
      conflicted: [
        { path: skillSrc, reason: 'unsafe-skill-dir' },
        { path: second, reason: 'unsafe-skill-dir' },
      ],
    });
    expect(snapshot(outside)).toEqual([]);
  });

  // Controls: real directories still mount, whether the workspace already
  // has them or not.
  test('real .claude and .claude/skills directories still mount', async () => {
    fs.mkdirSync(path.join(workspace, '.claude', 'skills'), { recursive: true });

    expect(await mount()).toEqual({ mounted: [skillSrc], conflicted: [] });

    expect(fs.readFileSync(path.join(workspace, '.claude', 'skills', name, 'SKILL.md'), 'utf8')).toBe('# my skill');
  });

  test('a workspace with no .claude gets real directories, not links', async () => {
    expect(await mount()).toEqual({ mounted: [skillSrc], conflicted: [] });

    expect(fs.lstatSync(path.join(workspace, '.claude')).isDirectory()).toBe(true);
    expect(fs.lstatSync(path.join(workspace, '.claude', 'skills')).isDirectory()).toBe(true);
  });
});

// F171 race residual: the check above reads .claude/skills, then the mount
// writes. A writer in the workspace could swap the directory for a link in
// between. Every write now happens in a host-private stage, and the workspace
// sees one re-checked rename; the old mount is moved out before it is deleted.
describe('mountSkills writes nothing through a .claude/skills swapped mid-mount (F171)', () => {
  let root;
  let workspace;
  let outside;
  let skillSrc;
  let name;
  let skillsDir;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-env-f171race-'));
    workspace = path.join(root, 'ws');
    outside = path.join(root, 'outside');
    skillSrc = path.join(root, 'src', 'my-skill');
    skillsDir = path.join(workspace, '.claude', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.mkdirSync(outside);
    fs.mkdirSync(skillSrc, { recursive: true });
    fs.writeFileSync(path.join(skillSrc, 'SKILL.md'), '# my skill', 'utf8');
    name = path.basename(skillSrc);
    // A marked directory outside the workspace, where a swapped link would
    // send the refresh's delete and copy.
    fs.mkdirSync(path.join(outside, name));
    fs.writeFileSync(path.join(outside, name, '.commonly-skill-mount'), 'mounted-from: elsewhere\n');
    fs.writeFileSync(path.join(outside, name, 'keep.txt'), 'real work');
  });
  afterEach(() => {
    const thaw = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) thaw(full);
        else if (e.isFile()) fs.chmodSync(full, 0o644);
      }
    };
    thaw(root);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const outsideTree = () => fs.readdirSync(path.join(outside, name)).sort()
    .map((e) => [e, fs.readFileSync(path.join(outside, name, e), 'utf8')]);
  const swapForLink = () => {
    fs.renameSync(skillsDir, path.join(workspace, '.claude', 'skills-real'));
    fs.symlinkSync(outside, skillsDir);
  };
  const mountWithSwapAt = async (at) => {
    let swapped = false;
    const result = await mountSkills({ skills: { claude: [skillSrc] } }, workspace, null, {
      onStep: (step) => {
        if (step === at && !swapped) { swapForLink(); swapped = true; }
      },
    });
    return { result, swapped };
  };
  const before = () => [['.commonly-skill-mount', 'mounted-from: elsewhere\n'], ['keep.txt', 'real work']];

  test.each(['checked', 'staged'])('a swap after the %s step is refused, and the target is left as it was', async (at) => {
    // An earlier mount, so the refresh has something to replace.
    expect((await mountSkills({ skills: { claude: [skillSrc] } }, workspace)).mounted).toEqual([skillSrc]);

    const { result, swapped } = await mountWithSwapAt(at);

    expect(swapped).toBe(true);
    expect(result).toEqual({ mounted: [], conflicted: [{ path: skillSrc, reason: 'unsafe-skill-dir' }] });
    expect(outsideTree()).toEqual(before());
    expect(fs.lstatSync(skillsDir).isSymbolicLink()).toBe(true);
  });

  test('the first mount into an empty slot is refused the same way', async () => {
    const { result, swapped } = await mountWithSwapAt('staged');

    expect(swapped).toBe(true);
    expect(result.conflicted).toEqual([{ path: skillSrc, reason: 'unsafe-skill-dir' }]);
    expect(outsideTree()).toEqual(before());
  });

  test('a mount with no swap lands, and leaves no stage folder behind', async () => {
    const siblingsBefore = fs.readdirSync(root).sort();

    expect(await mountSkills({ skills: { claude: [skillSrc] } }, workspace)).toEqual({ mounted: [skillSrc], conflicted: [] });
    expect(await mountSkills({ skills: { claude: [skillSrc] } }, workspace)).toEqual({ mounted: [skillSrc], conflicted: [] });

    const slot = path.join(skillsDir, name);
    expect(fs.readFileSync(path.join(slot, 'SKILL.md'), 'utf8')).toBe('# my skill');
    expect(fs.existsSync(path.join(slot, '.commonly-skill-mount'))).toBe(true);
    expect(fs.statSync(path.join(slot, 'SKILL.md')).mode & 0o777).toBe(0o444);
    expect(fs.readdirSync(root).sort()).toEqual(siblingsBefore);
    expect(fs.readdirSync(skillsDir)).toEqual([name]);
  });
});

// F171 gate: a skill source that is itself a link (common: ~/.claude/skills
// entries link into a checkout) was copied as a link, so the mount wrote
// through to the source: the marker landed in it and its files went 0444.
describe('mountSkills snapshots a linked skill source as real files (F171)', () => {
  let root;
  let workspace;
  let realSrc;
  let linkSrc;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-env-f171src-'));
    workspace = path.join(root, 'ws');
    realSrc = path.join(root, 'checkout', 'my-skill');
    linkSrc = path.join(root, 'skills', 'my-skill');
    fs.mkdirSync(workspace);
    fs.mkdirSync(realSrc, { recursive: true });
    fs.mkdirSync(path.dirname(linkSrc));
    fs.writeFileSync(path.join(realSrc, 'SKILL.md'), '# my skill', 'utf8');
    fs.chmodSync(path.join(realSrc, 'SKILL.md'), 0o644);
    fs.symlinkSync(realSrc, linkSrc);
  });
  afterEach(() => {
    for (const dir of [realSrc, path.join(workspace, '.claude', 'skills', 'my-skill')]) {
      if (!fs.existsSync(dir) || fs.lstatSync(dir).isSymbolicLink()) continue;
      for (const e of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, e), 0o644);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('the mount is a real directory, and the source is left as it was', async () => {
    expect(await mountSkills({ skills: { claude: [linkSrc] } }, workspace)).toEqual({ mounted: [linkSrc], conflicted: [] });

    const slot = path.join(workspace, '.claude', 'skills', 'my-skill');
    expect(fs.lstatSync(slot).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(slot, 'SKILL.md'), 'utf8')).toBe('# my skill');
    expect(fs.existsSync(path.join(realSrc, '.commonly-skill-mount'))).toBe(false);
    expect(fs.statSync(path.join(realSrc, 'SKILL.md')).mode & 0o777).toBe(0o644);
  });
});

// F171 review: when the stage is on another disk, a rename fails with EXDEV.
// The old fallback copied the snapshot in and then ran a recursive delete at
// the workspace path, which a .claude/skills swapped between the two steps
// sends outside. An EXDEV now refuses the mount and leaves the old one alone.
describe('mountSkills never copies and deletes through the workspace path (F171 review)', () => {
  let root;
  let workspace;
  let outside;
  let skillSrc;
  let skillsDir;
  const name = 'my-skill';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-env-f171exdev-'));
    workspace = path.join(root, 'ws');
    outside = path.join(root, 'outside');
    skillSrc = path.join(root, 'src', name);
    skillsDir = path.join(workspace, '.claude', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.mkdirSync(path.join(outside, name), { recursive: true });
    fs.writeFileSync(path.join(outside, name, '.commonly-skill-mount'), 'mounted-from: elsewhere\n');
    fs.writeFileSync(path.join(outside, name, 'keep.txt'), 'real work');
    fs.mkdirSync(skillSrc, { recursive: true });
    fs.writeFileSync(path.join(skillSrc, 'SKILL.md'), '# my skill', 'utf8');
  });
  afterEach(() => {
    const thaw = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) thaw(full);
        else if (e.isFile()) fs.chmodSync(full, 0o644);
      }
    };
    thaw(root);
    fs.rmSync(root, { recursive: true, force: true });
  });

  // A rename that fails as it would across disks, after swapping
  // .claude/skills for a link to `outside`, the moment the old fallback's
  // copy-then-delete left open.
  const crossDiskRenameWithSwap = () => async () => {
    if (!fs.lstatSync(skillsDir).isSymbolicLink()) {
      fs.renameSync(skillsDir, path.join(workspace, '.claude', 'skills-real'));
      fs.symlinkSync(outside, skillsDir);
    }
    throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
  };

  test('a refresh across disks is refused, and neither the old mount nor the swap target is touched', async () => {
    expect((await mountSkills({ skills: { claude: [skillSrc] } }, workspace)).mounted).toEqual([skillSrc]);

    const result = await mountSkills({ skills: { claude: [skillSrc] } }, workspace, null, { rename: crossDiskRenameWithSwap() });

    expect(result).toEqual({ mounted: [], conflicted: [{ path: skillSrc, reason: 'cross-disk-stage' }] });
    expect(fs.readdirSync(path.join(outside, name)).sort()).toEqual(['.commonly-skill-mount', 'keep.txt']);
    expect(fs.readFileSync(path.join(outside, name, 'keep.txt'), 'utf8')).toBe('real work');
    const kept = path.join(workspace, '.claude', 'skills-real', name);
    expect(fs.readFileSync(path.join(kept, 'SKILL.md'), 'utf8')).toBe('# my skill');
  });

  test('a first mount across disks is refused and writes nothing', async () => {
    const result = await mountSkills({ skills: { claude: [skillSrc] } }, workspace, null, {
      rename: async () => { throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' }); },
    });

    expect(result).toEqual({ mounted: [], conflicted: [{ path: skillSrc, reason: 'cross-disk-stage' }] });
    expect(fs.readdirSync(skillsDir)).toEqual([]);
  });
});

// F171 review: the source's own link is followed (a ~/.claude/skills entry
// into a checkout), but a link inside the source was followed too, so a
// `credentials.json -> ~/.commonly/tokens/x.json` came into the workspace as
// the token's bytes. A source holding any link of its own is now refused.
describe('mountSkills refuses a skill source that holds a link (F171 review)', () => {
  let root;
  let workspace;
  let skillSrc;
  let secret;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-env-f171nested-'));
    workspace = path.join(root, 'ws');
    skillSrc = path.join(root, 'src', 'my-skill');
    secret = path.join(root, 'tokens', 'agent.json');
    fs.mkdirSync(workspace);
    fs.mkdirSync(path.join(skillSrc, 'nested'), { recursive: true });
    fs.mkdirSync(path.dirname(secret));
    fs.writeFileSync(secret, 'cm_agent_planted_secret');
    fs.writeFileSync(path.join(skillSrc, 'SKILL.md'), '# my skill', 'utf8');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const workspaceBytes = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return workspaceBytes(full);
    return e.isFile() ? [fs.readFileSync(full, 'utf8')] : [];
  });

  test.each([['at the top of the source', 'credentials.json'], ['in a folder of the source', path.join('nested', 'creds.json')]])(
    'a link %s is refused, and its target never reaches the workspace',
    async (_where, rel) => {
      fs.symlinkSync(secret, path.join(skillSrc, rel));

      const result = await mountSkills({ skills: { claude: [skillSrc] } }, workspace);

      expect(result).toEqual({ mounted: [], conflicted: [{ path: skillSrc, reason: 'linked-skill-file' }] });
      expect(workspaceBytes(workspace).join('\n')).not.toContain('cm_agent_planted_secret');
      expect(fs.existsSync(path.join(workspace, '.claude', 'skills', 'my-skill'))).toBe(false);
    },
  );

  test('a source with no link inside still mounts', async () => {
    expect(await mountSkills({ skills: { claude: [skillSrc] } }, workspace)).toEqual({ mounted: [skillSrc], conflicted: [] });
  });
});

// F171 review, second pass. A seat can write its own workspace, so a source
// there (a relative entry resolves against it) can be made a link to host
// files; the source's own link must not be followed from inside it. And the
// renames still resolve the path, so whatever a swap moves into the stage is
// deleted only when it is a link or one of our marked mounts.
describe('mountSkills: a source the seat controls, and what a late swap can reach (F171 review)', () => {
  let root;
  let workspace;
  let host;
  let skillsDir;
  const name = 'my-skill';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-env-f171late-'));
    workspace = path.join(root, 'ws');
    host = path.join(root, 'host');
    skillsDir = path.join(workspace, '.claude', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.mkdirSync(path.join(host, name), { recursive: true });
    fs.writeFileSync(path.join(host, name, 'agent.json'), 'cm_agent_planted_secret');
  });
  afterEach(() => {
    const thaw = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) thaw(full);
        else if (e.isFile()) fs.chmodSync(full, 0o644);
      }
    };
    thaw(root);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const bytesUnder = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return bytesUnder(full);
    return e.isFile() ? [fs.readFileSync(full, 'utf8')] : [];
  });
  const stages = () => fs.readdirSync(root).filter((e) => e.startsWith('.commonly-skill-stage-'));

  test.each([['a relative entry', `skills/${name}`], ['an absolute path', null]])(
    'a source inside the workspace that links to host files is refused (%s)',
    async (_how, rel) => {
      fs.mkdirSync(path.join(workspace, 'skills'));
      fs.symlinkSync(path.join(host, name), path.join(workspace, 'skills', name));
      const source = rel || path.join(workspace, 'skills', name);

      const result = await mountSkills({ skills: { claude: [source] } }, workspace);

      expect(result.mounted).toEqual([]);
      expect(result.conflicted).toEqual([{ path: path.join(workspace, 'skills', name), reason: 'source-in-workspace' }]);
      expect(bytesUnder(path.join(workspace, '.claude')).join('\n')).not.toContain('cm_agent_planted_secret');
    },
  );

  test('a source outside the workspace that links into it is refused', async () => {
    fs.mkdirSync(path.join(workspace, 'mine'));
    fs.writeFileSync(path.join(workspace, 'mine', 'SKILL.md'), '# seat-written');
    const outsideLink = path.join(root, 'linked-skill');
    fs.symlinkSync(path.join(workspace, 'mine'), outsideLink);

    const result = await mountSkills({ skills: { claude: [outsideLink] } }, workspace);

    expect(result).toEqual({ mounted: [], conflicted: [{ path: outsideLink, reason: 'source-in-workspace' }] });
  });

  test('a source under a workspace folder whose name starts with two dots is refused', async () => {
    fs.mkdirSync(path.join(workspace, '..skills'));
    fs.symlinkSync(path.join(host, name), path.join(workspace, '..skills', name));
    const source = path.join(workspace, '..skills', name);

    const result = await mountSkills({ skills: { claude: [source] } }, workspace);

    expect(result).toEqual({ mounted: [], conflicted: [{ path: source, reason: 'source-in-workspace' }] });
    expect(bytesUnder(path.join(workspace, '.claude')).join('\n')).not.toContain('cm_agent_planted_secret');
  });

  test('a link chain that passes through the workspace is refused, though it ends outside', async () => {
    // linked-skill -> <ws>/mine, and the seat makes mine a link to host files.
    fs.symlinkSync(path.join(host, name), path.join(workspace, 'mine'));
    const outsideLink = path.join(root, 'linked-skill');
    fs.symlinkSync(path.join(workspace, 'mine'), outsideLink);

    const result = await mountSkills({ skills: { claude: [outsideLink] } }, workspace);

    expect(result).toEqual({ mounted: [], conflicted: [{ path: outsideLink, reason: 'source-in-workspace' }] });
    expect(bytesUnder(path.join(workspace, '.claude')).join('\n')).not.toContain('cm_agent_planted_secret');
    expect(fs.existsSync(path.join(host, name, '.commonly-skill-mount'))).toBe(false);
    expect(fs.statSync(path.join(host, name, 'agent.json')).mode & 0o200).toBeTruthy();
  });

  // macOS disks ignore case by default, so `<root>/WS` is the workspace. These
  // run only where the temp disk does that.
  const caselessTmp = (() => {
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-env-case-'));
    try {
      fs.mkdirSync(path.join(probe, 'ws'));
      return fs.existsSync(path.join(probe, 'WS'));
    } finally {
      fs.rmSync(probe, { recursive: true, force: true });
    }
  })();
  const onCaselessDisk = caselessTmp ? test : test.skip;

  onCaselessDisk('a chain through the workspace spelled in another case is refused', async () => {
    fs.symlinkSync(path.join(host, name), path.join(workspace, 'mine'));
    const outsideLink = path.join(root, 'linked-skill');
    fs.symlinkSync(path.join(root, 'WS', 'mine'), outsideLink);

    const result = await mountSkills({ skills: { claude: [outsideLink] } }, workspace);

    expect(result).toEqual({ mounted: [], conflicted: [{ path: outsideLink, reason: 'source-in-workspace' }] });
    expect(bytesUnder(path.join(workspace, '.claude')).join('\n')).not.toContain('cm_agent_planted_secret');
  });

  onCaselessDisk('a link spelled in another case that ends inside the workspace is refused', async () => {
    fs.mkdirSync(path.join(workspace, 'sub'));
    fs.writeFileSync(path.join(workspace, 'sub', 'SKILL.md'), '# seat-written');
    const outsideLink = path.join(root, 'cased-skill');
    fs.symlinkSync(path.join(root, 'WS', 'sub'), outsideLink);

    const result = await mountSkills({ skills: { claude: [outsideLink] } }, workspace);

    expect(result).toEqual({ mounted: [], conflicted: [{ path: outsideLink, reason: 'source-in-workspace' }] });
  });

  test('a source reached through a relative link with .. parts mounts when it stays outside', async () => {
    fs.mkdirSync(path.join(root, 'shelf'));
    fs.writeFileSync(path.join(root, 'shelf', 'SKILL.md'), '# shelf');
    fs.mkdirSync(path.join(root, 'links'));
    const viaDots = path.join(root, 'links', 'shelf-skill');
    fs.symlinkSync(path.join('..', 'shelf'), viaDots);

    const result = await mountSkills({ skills: { claude: [viaDots] } }, workspace);

    expect(result).toEqual({ mounted: [viaDots], conflicted: [] });
    expect(fs.readFileSync(path.join(skillsDir, 'shelf-skill', 'SKILL.md'), 'utf8')).toBe('# shelf');
  });

  test('a source that holds the workspace is refused', async () => {
    const result = await mountSkills({ skills: { claude: [root] } }, workspace);

    expect(result).toEqual({ mounted: [], conflicted: [{ path: root, reason: 'source-in-workspace' }] });
  });

  test('a source swapped for a link after it was resolved is refused, and the link target is not touched', async () => {
    const source = path.join(root, 'src', name);
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'SKILL.md'), '# my skill');

    const result = await mountSkills({ skills: { claude: [source] } }, workspace, null, {
      onStep: (step) => {
        if (step !== 'resolved') return;
        fs.renameSync(source, `${source}-real`);
        fs.symlinkSync(path.join(host, name), source);
      },
    });

    expect(result).toEqual({ mounted: [], conflicted: [{ path: source, reason: 'linked-skill-file' }] });
    expect(fs.readdirSync(path.join(host, name))).toEqual(['agent.json']);
    expect(fs.statSync(path.join(host, name, 'agent.json')).mode & 0o222).not.toBe(0);
  });

  test('a swap between the slot check and the move keeps whatever it moved, and deletes nothing', async () => {
    const source = path.join(root, 'src', name);
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'SKILL.md'), '# my skill');
    expect((await mountSkills({ skills: { claude: [source] } }, workspace)).mounted).toEqual([source]);

    const result = await mountSkills({ skills: { claude: [source] } }, workspace, null, {
      onStep: (step) => {
        if (step !== 'slot-checked') return;
        fs.renameSync(skillsDir, path.join(workspace, '.claude', 'skills-real'));
        fs.symlinkSync(host, skillsDir);
      },
    });

    expect(result).toEqual({ mounted: [], conflicted: [{ path: source, reason: 'unsafe-skill-dir' }] });
    // The unmarked host folder the swap sent into the stage is still on disk.
    const kept = stages().map((s) => path.join(root, s, 'old', 'agent.json')).filter((f) => fs.existsSync(f));
    expect(kept.map((f) => fs.readFileSync(f, 'utf8'))).toEqual(['cm_agent_planted_secret']);
  });

  test('when the second rename fails, the old mount is kept, not deleted', async () => {
    const source = path.join(root, 'src', name);
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'SKILL.md'), '# my skill');
    expect((await mountSkills({ skills: { claude: [source] } }, workspace)).mounted).toEqual([source]);

    let calls = 0;
    const result = await mountSkills({ skills: { claude: [source] } }, workspace, null, {
      rename: async (from, to) => {
        calls += 1;
        if (calls === 1) return fs.promises.rename(from, to);
        throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
      },
    });

    expect(result).toEqual({ mounted: [], conflicted: [{ path: source, reason: 'cross-disk-stage' }] });
    const kept = stages().map((s) => path.join(root, s, 'old', 'SKILL.md')).filter((f) => fs.existsSync(f));
    expect(kept).toHaveLength(1);
  });
});
