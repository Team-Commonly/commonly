// Agent-scoped catalog skills arrive from Commonly at each turn start. The
// wrapper gives their instructions to either adapter as prompt text, so a
// browser add/remove changes the next spawn without touching local files.
const MAX_BYTES = 64 * 1024;
const PREAMBLE = 'Installed skills for this agent and pod. Follow the applicable instructions below.';
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/;

export const compileServerSkills = (items = []) => {
  const sections = [];
  const mounted = [];
  const conflicted = [];
  let bytes = Buffer.byteLength(PREAMBLE);
  for (const item of items) {
    const name = String(item?.name || '').replace(/[\r\n]/g, ' ').trim();
    const content = String(item?.content || '').replace(FRONTMATTER, '').trim();
    if (!name || !content) continue;
    const section = `## Skill: ${name}\n\n${content}`;
    const nextBytes = Buffer.byteLength(section) + 2;
    if (bytes + nextBytes > MAX_BYTES) {
      conflicted.push(name);
      continue;
    }
    sections.push(section);
    mounted.push(name);
    bytes += nextBytes;
  }
  return {
    text: sections.length ? `${PREAMBLE}\n\n${sections.join('\n\n')}` : null,
    mounted,
    conflicted,
  };
};
