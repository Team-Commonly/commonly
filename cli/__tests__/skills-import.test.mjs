/**
 * skills-import.js unit tests — the metadata-only half of "your agent
 * arrives whole". Real temp dirs for detection; stub client for the wire.
 */

import os from 'os';
import path from 'path';
import fs from 'fs';

import {
  detectSkills,
  parseSkillMeta,
  skillStub,
  importSkills,
  MAX_SKILLS,
} from '../src/lib/skills-import.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

const writeSkill = (root, dir, frontmatter) => {
  const d = path.join(root, dir);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'SKILL.md'), frontmatter, 'utf8');
};

describe('parseSkillMeta', () => {
  test('reads name + description from frontmatter, strips quotes', () => {
    const meta = parseSkillMeta('---\nname: pod-manager\ndescription: "Manage pods end to end"\nextra: ignored\n---\n\n# Body', 'fallback');
    expect(meta).toEqual({ name: 'pod-manager', description: 'Manage pods end to end' });
  });

  test('falls back to the directory name without frontmatter', () => {
    expect(parseSkillMeta('# Just a doc', 'my-dir').name).toBe('my-dir');
  });
});

describe('detectSkills', () => {
  test('finds skills in cwd .claude/skills and dedupes by name across roots', () => {
    const cwd = tmp('sk-cwd-');
    const home = tmp('sk-home-');
    writeSkill(path.join(cwd, '.claude', 'skills'), 'alpha', '---\nname: alpha\ndescription: first\n---');
    writeSkill(path.join(home, '.claude', 'skills'), 'alpha', '---\nname: alpha\ndescription: shadowed\n---');
    writeSkill(path.join(home, '.claude', 'skills'), 'beta', '---\nname: beta\ndescription: second\n---');

    const skills = detectSkills({ cwd, home });
    expect(skills.map((s) => `${s.name}:${s.description}`)).toEqual(['alpha:first', 'beta:second']);
  });

  test('explicit dir wins; missing dir throws', () => {
    const cwd = tmp('sk-cwd2-');
    const dir = tmp('sk-explicit-');
    writeSkill(dir, 'gamma', '---\nname: gamma\ndescription: g\n---');
    expect(detectSkills({ cwd, home: tmp('sk-home2-'), explicitDir: dir })).toHaveLength(1);
    expect(() => detectSkills({ explicitDir: '/no/such/dir' })).toThrow(/No such directory/);
  });

  test(`caps at ${MAX_SKILLS}`, () => {
    const dir = tmp('sk-many-');
    for (let i = 0; i < MAX_SKILLS + 5; i += 1) {
      writeSkill(dir, `s${String(i).padStart(3, '0')}`, `---\nname: s${i}\ndescription: d\n---`);
    }
    expect(detectSkills({ explicitDir: dir })).toHaveLength(MAX_SKILLS);
  });
});

describe('importSkills', () => {
  test('posts one agent-scoped metadata stub per skill — never the content', async () => {
    const calls = [];
    const client = { post: async (url, body) => { calls.push({ url, body }); return {}; } };

    const result = await importSkills(client, {
      skills: [
        { name: 'alpha', description: 'first' },
        { name: 'beta', description: '' },
      ],
      podId: 'p1',
      agentName: 'my-claude',
      instanceId: 'default',
    });

    expect(result).toEqual({ imported: 2, names: ['alpha', 'beta'] });
    expect(calls).toHaveLength(2);
    const [a] = calls;
    expect(a.url).toBe('/api/skills/import');
    expect(a.body.scope).toBe('agent');
    expect(a.body.agentName).toBe('my-claude');
    expect(a.body.content).toContain('name: alpha');
    expect(a.body.content).toContain('intentionally not uploaded');
  });

  test('skillStub is frontmatter + provenance note only', () => {
    const stub = skillStub({ name: 'x', description: 'does x' });
    expect(stub).toContain('name: x');
    expect(stub).toContain('description: does x');
    expect(stub).not.toContain('```');
  });
});
