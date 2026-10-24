import { compileServerSkills } from '../src/lib/server-skills.js';

test('keeps whole skill bodies and reports a skill omitted by the prompt budget', () => {
  const result = compileServerSkills([
    { name: 'large', content: 'x'.repeat(70 * 1024) },
    { name: 'review', content: '---\nname: review\n---\nCheck the patch.' },
  ]);
  expect(result.mounted).toEqual(['review']);
  expect(result.conflicted).toEqual(['large']);
  expect(result.text).toContain('## Skill: review\n\nCheck the patch.');
  expect(result.text).not.toContain('name: review');
  expect(result.text).not.toContain('## Skill: large');
});
