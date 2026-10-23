// A public seat cannot load its declared skills as files, so each adapter
// delivers the SKILL.md bodies as instructions text instead:
//   - claude: skills are disabled outright (`--disable-slash-commands`,
//     `--setting-sources ''`), so the text rides as `--append-system-prompt`;
//   - codex: `exec` has no skill loader the seat can use, and a public seat's
//     CODEX_HOME is one this CLI owns, so the text is that home's AGENTS.md.
// One reader for both, so the two runtimes cannot drift on what a skill says.
import { readFile } from 'fs/promises';
import { isAbsolute, join, resolve as pathResolve } from 'path';
import { homedir } from 'os';

const SKILL_FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

export const SKILLS_AS_TEXT_PREAMBLE = 'These skills are part of how you work here. Skills are not loaded as files in this seat, '
  + 'so each one is given in full below. Follow them as you would a loaded skill.';

/**
 * A declared skill path as the environment spec means it: `~/` expanded,
 * relative paths taken from `baseDir`. The same resolution mountSkills applies.
 */
export const resolveSkillSource = (rawSource, baseDir) => {
  let source = rawSource;
  if (source === '~') source = homedir();
  else if (typeof source === 'string' && source.startsWith('~/')) source = join(homedir(), source.slice(2));
  return isAbsolute(source) ? source : pathResolve(baseDir, source);
};

const SECTION_SEPARATOR = '\n\n';

/**
 * Each source's SKILL.md as `## Skill: <name>` plus its body without the
 * frontmatter, in declared order. `maxBytes` bounds the whole text
 * skillsAsText returns (preamble, separators and `trailer` included), so a cap
 * is the size of what the runtime reads. A source with no SKILL.md, or one that
 * would cross the cap, is skipped with a warning naming the runtime (`label`)
 * rather than failing the spawn.
 */
export const readSkillSections = async (skillSources, { maxBytes, label, trailer = '', onIncluded }) => {
  const sections = [];
  let total = Buffer.byteLength(SKILLS_AS_TEXT_PREAMBLE, 'utf8') + Buffer.byteLength(trailer, 'utf8');
  for (const source of skillSources || []) {
    let markdown;
    try {
      // eslint-disable-next-line no-await-in-loop
      markdown = await readFile(join(source, 'SKILL.md'), 'utf8');
    } catch {
      // eslint-disable-next-line no-console
      console.warn(`[${label}] public seat: no SKILL.md to inline at ${source}`);
      continue;
    }
    const frontmatter = SKILL_FRONTMATTER_RE.exec(markdown);
    const name = (frontmatter && /^name:\s*(.+)$/m.exec(frontmatter[1])?.[1].trim())
      || source.split(/[\\/]/).filter(Boolean).pop();
    const section = `## Skill: ${name}\n\n${markdown.slice(frontmatter ? frontmatter[0].length : 0).trim()}`;
    const bytes = Buffer.byteLength(SECTION_SEPARATOR, 'utf8') + Buffer.byteLength(section, 'utf8');
    if (total + bytes > maxBytes) {
      // eslint-disable-next-line no-console
      console.warn(`[${label}] public seat: skill ${name} not inlined (over ${maxBytes} bytes in total)`);
      continue;
    }
    total += bytes;
    sections.push(section);
    onIncluded?.(source);
  }
  return sections;
};

/** The preamble, every section and `trailer`, or null when no skill could be read. */
export const skillsAsText = async (skillSources, options) => {
  const sections = await readSkillSections(skillSources, options);
  return sections.length
    ? `${SKILLS_AS_TEXT_PREAMBLE}${SECTION_SEPARATOR}${sections.join(SECTION_SEPARATOR)}${options.trailer || ''}`
    : null;
};
