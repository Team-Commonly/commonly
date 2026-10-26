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
const { daemonSetupCommandTemplate } = require('../../utils/daemonSetupCommandTemplate');

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
const byo = read('docs-site/bring-your-own/index.mdx');
const repoWork = read('docs-site/bring-your-own/work-in-your-repo.mdx');
const navigation = JSON.parse(read('docs-site/docs.json'));

describe('docs.commonly.me says what the product does', () => {
  test('the quickstart starts on commonly.me, not with a clone', () => {
    expect(quickstart).toMatch(/commonly\.me/);
    expect(quickstart).not.toMatch(/git clone/);
    expect(quickstart).not.toMatch(/install\.sh/);
  });

  test('the quickstart is the hosted path and the deeper connect page keeps the CLI commands', () => {
    const install = constantFromPage('CLI_INSTALL_COMMAND');
    // The docs site describes commonly.me, so its command names that instance.
    const daemon = daemonSetupCommandTemplate('https://api.commonly.me');
    expect(quickstart).toContain('Run it here');
    expect(quickstart).not.toContain('npm i -g');
    expect(connect).toContain(install);
    expect(connect).toContain(daemon);
    expect(connect).toContain('agent init --language python --name echo-bot --pod <podId>');
    expect(connect).toContain('COMMONLY_BASE_URL=https://api.commonly.me python3 bot.py');
    // Both connect forms: the terminal card form first, the headless export second.
    expect(connect).toContain('commonly agent attach claude --pod <podId> --name my-claude');
    expect(connect).toContain('export COMMONLY_AGENT_TOKEN=cm_agent_<token>');
    expect(connect).toContain('commonly agent run my-claude --adapter claude');
  });

  test('the quickstart links live hosted limits instead of freezing plan numbers', () => {
    const agents = hostedDefault('DEFAULT_AGENTS_PER_USER');
    expect(agents).toBe(1);
    expect(quickstart).toContain('https://commonly.me/v2/agents/byo?mode=hosted');
    expect(quickstart).toMatch(/free plan's current agent and daily turn limits/);
    expect(quickstart).not.toMatch(/\b\d+ turns? a day\b/);
  });

  test('the agent guides separate MCP from a listener, and none calls MCP recommended', () => {
    expect(byo).toMatch(/A listener is needed.*answer @mentions/);
    expect(repoWork).toMatch(/MCP server does not listen for @mentions/);
    expect(connect).toMatch(/MCP alone does not answer @mentions/);
    const pages = fs.readdirSync(path.join(ROOT, 'docs-site'), { recursive: true })
      .filter((f) => String(f).endsWith('.mdx'))
      .map((f) => [String(f), read(path.join('docs-site', String(f)))]);
    const offenders = pages.filter(([, body]) => /MCP\s*\(recommended\)/i.test(body)).map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  test('the terminal form leads, then headless, then the webhook program, before the MCP server', () => {
    const at = (heading) => connect.indexOf(heading);
    expect(at('## Run it on your terminal')).toBeGreaterThan(-1);
    expect(at('## Run it on your terminal')).toBeLessThan(at('## Run it headless'));
    expect(at('## Run it headless')).toBeLessThan(at('## Your own program'));
    expect(at('## Your own program')).toBeLessThan(at('## The MCP server'));
  });

  test('the Bring your own navigation lists walked runtimes only', () => {
    const groups = navigation.navigation.tabs[0].groups;
    const guides = groups.find((group) => group.group === 'Bring Your Own Agent').pages;
    ['claude-code', 'codex', 'opencode', 'hermes', 'deepseek-harness', 'work-in-your-repo']
      .forEach((guide) => expect(guides).toContain(`bring-your-own/${guide}`));
    ['qwen', 'pi', 'gemini', 'goose']
      .forEach((guide) => expect(guides).not.toContain(`bring-your-own/${guide}`));
    expect(connect).not.toMatch(/--adapter (qwen|opencode|pi)\b/);
  });
});
