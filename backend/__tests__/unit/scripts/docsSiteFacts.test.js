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

  test('the Claude Code and repo pages run the CLI through npx, with no global install (F582)', () => {
    const npx = constantFromPage('CLI_NPX_COMMAND');
    const claudeCode = read('docs-site/bring-your-own/claude-code.mdx');
    [claudeCode, repoWork].forEach((page) => {
      expect(page).not.toContain('npm i -g @commonlyai/cli');
      expect(page).not.toMatch(/^commonly /m);
    });
    expect(claudeCode).toContain(`${npx} agent run your-agent-name --adapter claude`);
    expect(repoWork).toContain(`${npx} login\n${npx} agent attach claude --pod <pod-id>`);
    const readme = read('README.md');
    expect(readme).not.toContain('npm i -g @commonlyai/cli');
    expect(readme).toContain(`${npx} agent run <your-agent-name> --adapter claude`);
  });

  test('no code block in the agent pages starts a line with a bare commonly (F582)', () => {
    const dir = 'docs-site/bring-your-own';
    const files = [
      ...fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.mdx')).map((f) => `${dir}/${f}`),
      'commonly-mcp/README.md',
      'docs/MCP_INTEGRATION.md',
    ];
    const offenders = [];
    files.forEach((rel) => {
      const blocks = read(rel).match(/```[^\n]*\n[\s\S]*?```/g) || [];
      blocks.forEach((block) => block.split('\n').forEach((line) => {
        if (/^\s*(>\s*)?commonly(\.cmd)? /.test(line)) offenders.push(`${rel}: ${line.trim()}`);
      }));
    });
    // An inline command a person is told to run counts too: one after "run",
    // or one with arguments opening a line. Naming a command in a sentence
    // ("`commonly agent run` refuses …") does not.
    files.forEach((rel) => {
      read(rel).split('\n').forEach((line) => {
        (line.match(/\brun `commonly(?:\.cmd)? [^`]+`/g) || [])
          .forEach((hit) => offenders.push(`${rel}: ${hit}`));
        const opening = line.match(/^\s*(?:>\s*)?(?:[-*]\s+)?`(commonly(?:\.cmd)?(?: [^ `]+){3,}[^`]*)`/);
        if (opening) offenders.push(`${rel}: ${opening[1]}`);
      });
    });
    expect(offenders).toEqual([]);
    // Prose that names what the copied command does says npx, not an install.
    expect(read(`${dir}/codex.mdx`)).not.toMatch(/installs `@commonlyai\/cli`/);
  });

  test('the quickstart is the hosted path and the deeper connect page keeps the CLI commands', () => {
    // F570: the CLI runs through npx, as the Bring your own page runs it.
    const npx = constantFromPage('CLI_NPX_COMMAND');
    // The docs site describes commonly.me, so its command names that instance.
    const daemon = daemonSetupCommandTemplate('https://api.commonly.me');
    expect(quickstart).toContain('Run it here');
    expect(quickstart).not.toContain('npm i -g');
    expect(connect).not.toContain('npm i -g @commonlyai/cli');
    expect(connect).toContain(daemon);
    expect(connect).toContain('agent init --language python --name echo-bot --pod <podId>');
    expect(connect).toContain('COMMONLY_BASE_URL=https://api.commonly.me python3 bot.py');
    // Single-agent attach stays documented for existing setups, with the headless export after it.
    expect(connect).toContain(`${npx} agent attach claude --pod <podId> --name my-claude`);
    expect(connect).toContain('export COMMONLY_AGENT_TOKEN=cm_agent_<token>');
    expect(connect).toContain(`${npx} agent run my-claude --adapter claude`);
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

  test('the daemon leads, then attach for existing setups, headless, the webhook program, and the MCP server', () => {
    // Connecting your computer is the way in; single-agent attach is kept for existing setups.
    const at = (heading) => connect.indexOf(heading);
    expect(at('## Connect your computer')).toBeGreaterThan(-1);
    expect(at('## Connect your computer')).toBeLessThan(at('## Existing setups: `agent attach`'));
    expect(at('## Existing setups: `agent attach`')).toBeLessThan(at('## Run it headless'));
    expect(at('## Run it headless')).toBeLessThan(at('## Your own program'));
    expect(at('## Your own program')).toBeLessThan(at('## The MCP server'));
  });

  test('the Bring your own navigation lists walked runtimes only', () => {
    const groups = navigation.navigation.tabs[0].groups;
    const guides = groups.find((group) => group.group === 'Bring Your Own Agent').pages;
    ['claude-code', 'codex', 'opencode', 'deepseek-harness', 'work-in-your-repo']
      .forEach((guide) => expect(guides).toContain(`bring-your-own/${guide}`));
    ['qwen', 'pi', 'gemini', 'goose', 'hermes']
      .forEach((guide) => expect(guides).not.toContain(`bring-your-own/${guide}`));
    expect(connect).not.toMatch(/--adapter (qwen|opencode|pi)\b/);
  });
});
