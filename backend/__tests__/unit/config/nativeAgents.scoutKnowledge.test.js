/**
 * Scout's onboarding facts must match the page it describes.
 *
 * Scout answers "how do I connect my agent?" from its system prompt. That copy
 * went stale once already (2026-10-14): it pointed at a label the Agents page no
 * longer has and named a runtime with no adapter, and strangers who asked got
 * "I don't know". These tests read the commands straight from the Bring-your-own
 * page component, so the next drift fails here instead of in a user's first
 * conversation.
 */
const fs = require('fs');
const path = require('path');

const { scoutApp } = require('../../../config/native-agents/scout');

const BYO_PAGE = path.resolve(__dirname, '../../../../frontend/src/v2/components/V2AgentBYO.tsx');

const constantFromPage = (name) => {
  const source = fs.readFileSync(BYO_PAGE, 'utf8');
  const match = source.match(new RegExp(`const ${name} = '([^']+)'`));
  if (!match) throw new Error(`${name} not found in V2AgentBYO.tsx`);
  return match[1];
};

describe('Scout onboarding knowledge', () => {
  const prompt = scoutApp.systemPrompt;

  test('gives the exact install and machine commands the Bring-your-own page shows', () => {
    expect(prompt).toContain(constantFromPage('CLI_INSTALL_COMMAND'));
    expect(prompt).toContain(constantFromPage('DAEMON_SETUP_COMMAND'));
    expect(prompt).toContain('export COMMONLY_API_URL=');
    expect(prompt).toContain('export COMMONLY_AGENT_TOKEN=');
    expect(prompt).toContain('commonly agent run <name>');
  });

  test('says MCP alone does not answer mentions, and names the command that does', () => {
    expect(prompt).toMatch(/MCP alone does NOT answer @mentions/);
    expect(prompt).toMatch(/last command is what makes their agent answer @mentions/);
  });

  // QA BYO walk 1 (2026-10-16): the card said "local agent seat", "issue its
  // token" and "start the listener", and the command fell back to Codex.
  test('the card speaks plainly, and the command pins the tool it runs', () => {
    expect(prompt).toMatch(/Never say seat, token, listener, runtime or connect page to them/);
    expect(prompt).toMatch(/commonly agent run <name> --adapter claude/);
  });

  test('names the labels the Agents page actually has, and no stale ones', () => {
    expect(prompt).toContain('"Bring your own"');
    expect(prompt).toContain('"Run it here"');
    expect(prompt).not.toContain('Connect your own agent');
  });

  test('claims no runtime without an adapter', () => {
    expect(prompt).not.toMatch(/Cursor/);
  });

  // Linux run 38982219348: a Claude Code listener cannot run on Linux, WSL or
  // Windows (#2288 refuses it), so a connect card for it there is a dead end.
  test('offers a connect card for Claude Code on a Mac only, and says what works elsewhere', () => {
    expect(prompt).toMatch(/on a Mac, Claude Code or Codex\. On Linux \(WSL included\), Codex only\./);
    expect(prompt).toMatch(/For Claude Code on Linux, WSL or Windows, do not propose a connect card/);
    expect(prompt).toMatch(/commonly_offer_hosted_agent, or say they can use the pod from their own Claude Code sessions/);
    expect(prompt).not.toMatch(/Windows is not verified yet/);
  });

  test('asks the OS before any command, and never hands out the listener without install and token', () => {
    expect(prompt).toMatch(/Before ANY terminal command: if you do not know their operating system, ask for it and give no commands/);
    expect(prompt).toMatch(/Never give `commonly agent run` on its own/);
    expect(prompt).toMatch(/"Use my own agent"/);
  });

  test('gives both halves when their tool can call agents: the listener and the MCP line', () => {
    expect(prompt).toMatch(/give both halves: the Terminal command/);
    expect(prompt).toMatch(/and the MCP line/);
  });

  test('cites developer docs that exist in the repository', () => {
    const repo = path.resolve(__dirname, '../../../..');
    for (const doc of ['docs/agents/BUILDING_AN_AGENT.md', 'docs/api/openapi.yaml']) {
      expect(prompt).toContain(doc);
      expect(fs.existsSync(path.join(repo, doc))).toBe(true);
    }
    expect(prompt).not.toContain('cap-kernel.yaml');
  });

  test('answers first, asks at most one question, and never promises a response time', () => {
    expect(prompt).toMatch(/Answer the literal question first/);
    expect(prompt).toMatch(/at most one question per turn/);
    expect(prompt).not.toMatch(/within the hour|within an hour|you will hear back|you'll hear/i);
  });

  // QA 2026-10-16: Scout said "200 turns a day" while the card and the meter
  // said 30, because the prompt kept its own copy of the plan line. The limits
  // now reach Scout only through the hosted offer's description.
  test('quotes no hosted limit from memory, and hands off to Run it here with a button', () => {
    expect(prompt).not.toMatch(/\d+\s+turns (a|per) day/i);
    expect(prompt).toContain('commonly_offer_hosted_agent');
    expect(scoutApp.tools).toContain('commonly_offer_hosted_agent');
    expect(prompt).toMatch(/with no invitation code/);
  });
});
