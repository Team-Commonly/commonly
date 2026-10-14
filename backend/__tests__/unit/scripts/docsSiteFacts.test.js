/**
 * The public docs must say what the product does.
 *
 * Earned 2026-10-14. docs.commonly.me's Quickstart was a self-hosting guide, so
 * a stranger asking "how do I start?" was told to clone the repo. Its Connect
 * page labelled MCP "recommended", though MCP alone never answers an @mention —
 * the exact trap Scout had just been taught to warn about. Scout, the Bring your
 * own page and the docs are three copies of one set of facts, and copies drift.
 * These arms read the facts from their sources (the page component and the
 * hosted caps in code), so the next drift fails here instead of on the site.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const BYO_PAGE = 'frontend/src/v2/components/V2AgentBYO.tsx';
const constantFromPage = (name) => {
  const match = read(BYO_PAGE).match(new RegExp(`const ${name} = '([^']+)'`));
  if (!match) throw new Error(`${name} not found in ${BYO_PAGE}`);
  return match[1];
};
const hostedDefault = (name) => {
  const match = read('backend/services/hostedRuntimeService.ts').match(new RegExp(`const ${name} = (\\d+);`));
  if (!match) throw new Error(`${name} not found in hostedRuntimeService.ts`);
  return Number(match[1]);
};

const quickstart = read('docs-site/quickstart.mdx');
const connect = read('docs-site/agents/connect.mdx');

describe('docs.commonly.me says what the product does', () => {
  test('the quickstart starts on commonly.me, not with a clone', () => {
    expect(quickstart).toMatch(/commonly\.me/);
    expect(quickstart).not.toMatch(/git clone/);
    expect(quickstart).not.toMatch(/install\.sh/);
  });

  test('the install and computer commands are the ones the Bring your own page shows', () => {
    const install = constantFromPage('CLI_INSTALL_COMMAND');
    const daemon = constantFromPage('DAEMON_SETUP_COMMAND');
    [quickstart, connect].forEach((page) => {
      expect(page).toContain(install);
      expect(page).toContain(daemon);
      expect(page).toContain('export COMMONLY_API_URL=https://api.commonly.me');
      expect(page).toContain('export COMMONLY_AGENT_TOKEN=');
      expect(page).toContain('commonly agent run <agent-name>');
    });
  });

  test('the hosted limits match the code', () => {
    const turns = hostedDefault('DEFAULT_TURNS_PER_DAY');
    const agents = hostedDefault('DEFAULT_AGENTS_PER_USER');
    expect(quickstart).toContain(`${turns} turns a day`);
    expect(agents).toBe(1);
    expect(quickstart).toMatch(/run one hosted agent/);
  });

  test('both pages say MCP alone does not answer mentions, and none calls MCP recommended', () => {
    expect(quickstart).toMatch(/does not make your agent\s+answer @mentions/);
    expect(connect).toMatch(/MCP alone does not answer @mentions/);
    const pages = fs.readdirSync(path.join(ROOT, 'docs-site'), { recursive: true })
      .filter((f) => String(f).endsWith('.mdx'))
      .map((f) => [String(f), read(path.join('docs-site', String(f)))]);
    const offenders = pages.filter(([, body]) => /MCP\s*\(recommended\)/i.test(body)).map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  test('the listener comes before the MCP server on the connect page', () => {
    expect(connect.indexOf('## The listener')).toBeGreaterThan(-1);
    expect(connect.indexOf('## The listener')).toBeLessThan(connect.indexOf('## The MCP server'));
  });

  test('the listener claims only the adapters Scout is allowed to name', () => {
    // Scout's verified facts: the listener runs Claude Code or Codex. Other
    // adapters exist in the CLI but are not verified for public seats yet.
    [quickstart, connect].forEach((page) => {
      expect(page).toMatch(/Claude Code if it\s+is\s+installed,\s+otherwise\s+Codex/);
      expect(page).not.toMatch(/--adapter (qwen|opencode|pi)\b/);
    });
  });
});
