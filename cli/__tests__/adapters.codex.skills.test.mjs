/**
 * A public Codex seat gets its declared skills as $CODEX_HOME/AGENTS.md.
 *
 * Found 2026-10-20: this adapter never read `environment.skills`, so every
 * outsider's Codex seat ran without the house rules buildDefaultEnvironment
 * declares for it. The Claude half of the same gap shipped in #2354. Codex
 * reads $CODEX_HOME/AGENTS.md under the public flags, on a new thread and on
 * `exec resume` (measured on codex-cli 0.162.1); a public seat's home is one
 * the CLI owns, so the declared SKILL.md bodies are written there.
 */

import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

await jest.unstable_mockModule('child_process', () => ({
  spawnSync: jest.fn(),
  spawn: jest.fn(),
}));

const codex = (await import('../src/lib/adapters/codex.js')).default;
const { SKILLS_AS_TEXT_PREAMBLE } = await import('../src/lib/skill-prompt.js');

// The fake codex reads AGENTS.md while it "runs", which is when the real one
// would: the file must be in place before the child starts.
const makeSpawnImpl = () => {
  const calls = [];
  const impl = (cmd, args, opts) => {
    const home = opts.env.CODEX_HOME;
    const seen = readFile(join(home, 'AGENTS.md'), 'utf8').catch(() => null);
    calls.push({ args, opts, seen });
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = jest.fn();
    setTimeout(async () => {
      await seen;
      proc.stdout.emit('data', Buffer.from('{"type":"thread.started","thread_id":"sid-skill"}\n'));
      const outIdx = args.indexOf('-o');
      await writeFile(args[outIdx + 1], 'ok', 'utf8');
      proc.emit('close', 0);
    }, 0);
    return proc;
  };
  return { impl, calls };
};

const HOUSE_RULES = '---\nname: commonly\ndescription: How to behave in a pod.\n---\n\n# Being a good Commonly member\n\nOrient before you post.\n';

describe('codex adapter — a public seat gets its declared skills as AGENTS.md', () => {
  let root;
  let operatorHome;
  let publicHome;
  let workspace;
  let skillSrc;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cli-codex-skill-'));
    operatorHome = join(root, 'operator-codex');
    publicHome = join(root, 'public-codex');
    workspace = join(root, 'workspace');
    skillSrc = join(root, 'skills', 'commonly');
    await Promise.all([operatorHome, publicHome, workspace, skillSrc].map((dir) => mkdir(dir, { recursive: true })));
    await writeFile(join(skillSrc, 'SKILL.md'), HOUSE_RULES, 'utf8');
    await writeFile(join(operatorHome, 'AGENTS.md'), '# The operator\'s private instructions\n', 'utf8');
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const spawnSeat = (impl, environment, extra = {}) => codex.spawn('hi', {
    sessionId: null,
    cwd: workspace,
    agentName: 'skill-test-agent',
    environment,
    env: { ...process.env, CODEX_HOME: operatorHome },
    _publicCodexHome: publicHome,
    _spawnImpl: impl,
    ...extra,
  });

  test('the skill body is in the public home\'s AGENTS.md before codex starts, without frontmatter', async () => {
    const { impl, calls } = makeSpawnImpl();
    const onSkillsLinked = jest.fn();
    await spawnSeat(impl, { sandbox: { trust: 'public' }, skills: { claude: [skillSrc] } }, { onSkillsLinked });

    expect(calls).toHaveLength(1);
    expect(calls[0].opts.env.CODEX_HOME).toBe(publicHome);
    const seen = await calls[0].seen;
    expect(seen).toContain('## Skill: commonly');
    expect(seen).toContain('# Being a good Commonly member\n\nOrient before you post.');
    expect(seen).not.toContain('description: How to behave');
    expect(seen).not.toContain('private instructions');
    expect(onSkillsLinked).toHaveBeenCalledWith({ mounted: [skillSrc], conflicted: [] });
  });

  test('the file is private to the operator', async () => {
    const { impl } = makeSpawnImpl();
    await spawnSeat(impl, { sandbox: { trust: 'public' }, skills: { claude: [skillSrc] } });
    // eslint-disable-next-line no-bitwise
    expect((await stat(join(publicHome, 'AGENTS.md'))).mode & 0o777).toBe(0o600);
  });

  test('a relative skill path is taken from the workspace', async () => {
    const local = join(workspace, 'house');
    await mkdir(local);
    await writeFile(join(local, 'SKILL.md'), '# Local rules\n\nBe brief.\n', 'utf8');
    const { impl, calls } = makeSpawnImpl();
    await spawnSeat(impl, { sandbox: { trust: 'public' }, skills: { claude: ['./house'] } });

    expect(await calls[0].seen).toContain('## Skill: house\n\n# Local rules');
  });

  test('a skill dropped from the declaration stops applying on the next spawn', async () => {
    const first = makeSpawnImpl();
    await spawnSeat(first.impl, { sandbox: { trust: 'public' }, skills: { claude: [skillSrc] } });
    expect(await first.calls[0].seen).toContain('## Skill: commonly');

    const second = makeSpawnImpl();
    await spawnSeat(second.impl, { sandbox: { trust: 'public' } });
    expect(await second.calls[0].seen).toBeNull();
  });

  test('a declared skill with no SKILL.md is skipped, not fatal', async () => {
    await rm(join(skillSrc, 'SKILL.md'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { impl, calls } = makeSpawnImpl();
    const onSkillsLinked = jest.fn();
    await spawnSeat(impl, { sandbox: { trust: 'public' }, skills: { claude: [skillSrc] } }, { onSkillsLinked });

    expect(calls).toHaveLength(1);
    expect(await calls[0].seen).toBeNull();
    expect(warn).toHaveBeenCalledWith(`[codex] public seat: no SKILL.md to inline at ${skillSrc}`);
    expect(onSkillsLinked).toHaveBeenCalledWith({ mounted: [], conflicted: [{ path: skillSrc, reason: 'not-inlined' }] });
    warn.mockRestore();
  });

  // Vera on #2368: raising the cap to 1 GiB failed no arm (C5), and the cap
  // first counted only the sections, so a file that met it ran 168 bytes past
  // it once the preamble, separators and final newline were added. The cap is
  // our own ceiling on the file as written (Codex does not cap this file; see
  // the comment on PUBLIC_CODEX_INSTRUCTIONS_MAX_BYTES), so these arms measure
  // the file itself, one byte either side of 32768.
  const capFixture = async (bodyBytes) => {
    const big = join(root, 'skills', 'big');
    const after = join(root, 'skills', 'after');
    await mkdir(big, { recursive: true });
    await mkdir(after, { recursive: true });
    await writeFile(join(big, 'SKILL.md'), `---\nname: big\n---\n${'x'.repeat(bodyBytes)}\n`, 'utf8');
    await writeFile(join(after, 'SKILL.md'), '---\nname: after\n---\nOne more line.\n', 'utf8');
    return [big, after];
  };
  // preamble + "\n\n" + "## Skill: big\n\n" + body + "\n" is the whole file.
  const bodyForFileOf = (fileBytes) => fileBytes
    - Buffer.byteLength(SKILLS_AS_TEXT_PREAMBLE, 'utf8') - 2 - Buffer.byteLength('## Skill: big\n\n', 'utf8') - 1;

  test('a skill that brings AGENTS.md to exactly 32768 bytes is inlined, and the file is 32768 bytes', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { impl, calls } = makeSpawnImpl();
    await spawnSeat(impl, { sandbox: { trust: 'public' }, skills: { claude: await capFixture(bodyForFileOf(32768)) } });

    const seen = await calls[0].seen;
    expect(seen).toContain('## Skill: big');
    expect(seen).not.toContain('## Skill: after');
    expect(Buffer.byteLength(seen, 'utf8')).toBe(32768);
    expect(warn).toHaveBeenCalledWith('[codex] public seat: skill after not inlined (over 32768 bytes in total)');
    warn.mockRestore();
  });

  test('one byte more and that skill is left out whole, while a later one that fits still goes in', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { impl, calls } = makeSpawnImpl();
    await spawnSeat(impl, { sandbox: { trust: 'public' }, skills: { claude: await capFixture(bodyForFileOf(32768) + 1) } });

    const seen = await calls[0].seen;
    expect(seen).not.toContain('## Skill: big');
    expect(seen).toContain('## Skill: after');
    expect(Buffer.byteLength(seen, 'utf8')).toBeLessThanOrEqual(32768);
    expect(warn).toHaveBeenCalledWith('[codex] public seat: skill big not inlined (over 32768 bytes in total)');
    warn.mockRestore();
  });

  test('a private seat runs on the operator\'s own home, which is never written', async () => {
    const { impl, calls } = makeSpawnImpl();
    await spawnSeat(impl, { skills: { claude: [skillSrc] } });

    expect(calls[0].opts.env.CODEX_HOME).toBe(operatorHome);
    expect(await readFile(join(operatorHome, 'AGENTS.md'), 'utf8')).toBe('# The operator\'s private instructions\n');
    await expect(stat(join(publicHome, 'AGENTS.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
