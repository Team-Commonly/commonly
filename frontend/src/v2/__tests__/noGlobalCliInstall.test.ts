// F582: on a stock Mac, Node from the nodejs.org installer leaves npm's global
// prefix root-owned, so `npm i -g @commonlyai/cli` stops with EACCES, nothing
// is installed, and the next bare `commonly …` line is "command not found".
// The Bring your own page runs the CLI through npx (CLI_NPX_COMMAND, F570);
// the other surfaces that hand a person a command follow it.
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const pageNpx = (read('v2/components/V2AgentBYO.tsx').match(/const CLI_NPX_COMMAND = '([^']+)'/) || [])[1];

describe('no surface tells a person to install the CLI globally', () => {
  test('the landing page, the guides and the locales name no global install', () => {
    ['v2/landing/V2LandingPage.tsx', 'content/guides.json', 'i18n/locales/en.json', 'i18n/locales/zh-CN.json']
      .forEach((rel) => expect(read(rel)).not.toMatch(/npm (i|install) -g @commonlyai\/cli/));
  });

  test('the landing page shows the CLI run through npx, as the Bring your own page does', () => {
    expect(pageNpx).toBe('npx -y @commonlyai/cli@latest');
    expect(read('v2/landing/V2LandingPage.tsx')).toContain(`${pageNpx} agent run my-agent`);
  });

  test('no guide code block starts a line with a bare commonly', () => {
    const guides = JSON.parse(read('content/guides.json'));
    const codes: string[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') {
        Object.entries(node as Record<string, unknown>).forEach(([key, value]) => {
          if (key === 'code' && typeof value === 'string') codes.push(value);
          else walk(value);
        });
      }
    };
    walk(guides);
    expect(codes.length).toBeGreaterThan(0);
    expect(codes.filter((code) => /^commonly /m.test(code))).toEqual([]);
  });
});
