// resolvePresetSkills reports, per preset default skill, whether the skill
// exists and whether its binaries and env are in place. No preset names a
// default skill today (F418), so the presets route no longer exercises it;
// the auto-import stays for a future runtime, and so does this coverage (F419).

jest.mock('../../../middleware/auth', () => (req, res, next) => next());

const { resolvePresetSkills } = require('../../../routes/registry/presets-router');

const PROBE_ENV = 'PRESET_SKILL_PROBE_FLAG';

const builtInSkills = {
  skills: [
    { id: 'needs-bin', requiresBins: ['ffmpeg'], requiresEnv: [] },
    { id: 'needs-env', requiresBins: [], requiresEnv: [PROBE_ENV] },
    { id: 'plain', requiresBins: [], requiresEnv: [] },
  ],
};

const resolve = (ids, dockerCapabilities = { aptPackages: [], pythonPackages: [] }) => resolvePresetSkills({
  preset: { defaultSkills: ids.map((id) => ({ id, reason: `why ${id}` })) },
  builtInSkills,
  dockerCapabilities,
});

describe('resolvePresetSkills', () => {
  const saved = process.env[PROBE_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[PROBE_ENV];
    else process.env[PROBE_ENV] = saved;
  });

  it('returns nothing for a preset without default skills', () => {
    expect(resolvePresetSkills({ preset: {}, builtInSkills, dockerCapabilities: {} })).toEqual([]);
  });

  it('marks a skill the runtime does not have as missing-skill', () => {
    const [skill] = resolve(['nowhere']);
    expect(skill).toMatchObject({
      id: 'nowhere', reason: 'why nowhere', available: false, setupStatus: 'missing-skill',
    });
    expect(skill.readiness.ready).toBe(false);
  });

  it('needs-package-install until the binary is in the image, then ready', () => {
    const [missing] = resolve(['needs-bin']);
    expect(missing.setupStatus).toBe('needs-package-install');
    expect(missing.binStatus).toEqual([{ bin: 'ffmpeg', installed: false }]);
    expect(missing.readiness).toEqual({ binsReady: false, envReady: true, ready: false });

    const [installed] = resolve(['needs-bin'], { aptPackages: ['ffmpeg'], pythonPackages: [] });
    expect(installed.setupStatus).toBe('ready');
    expect(installed.binStatus).toEqual([{ bin: 'ffmpeg', installed: true }]);
  });

  it('needs-api-env until the env is set, and a false-y flag counts as unset', () => {
    delete process.env[PROBE_ENV];
    expect(resolve(['needs-env'])[0].setupStatus).toBe('needs-api-env');
    process.env[PROBE_ENV] = 'false';
    expect(resolve(['needs-env'])[0].envStatus).toEqual([{ key: PROBE_ENV, configured: false }]);
    process.env[PROBE_ENV] = 'set';
    const [ready] = resolve(['needs-env']);
    expect(ready.setupStatus).toBe('ready');
    expect(ready.readiness.ready).toBe(true);
  });

  it('a skill with no requirements is ready and keeps preset order', () => {
    const skills = resolve(['plain', 'nowhere']);
    expect(skills.map((skill) => [skill.id, skill.setupStatus])).toEqual([
      ['plain', 'ready'], ['nowhere', 'missing-skill'],
    ]);
  });
});
