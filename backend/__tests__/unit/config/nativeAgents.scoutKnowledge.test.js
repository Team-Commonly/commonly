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
const { daemonSetupCommandTemplate } = require('../../utils/daemonSetupCommandTemplate');

const constantFromPage = (name) => {
  const source = fs.readFileSync(BYO_PAGE, 'utf8');
  const match = source.match(new RegExp(`const ${name} = '([^']+)'`));
  if (!match) throw new Error(`${name} not found in V2AgentBYO.tsx`);
  return match[1];
};

// Scout runs on every instance, so its copy names the URL placeholder, never a
// production host (CodeRabbit on #2727).
const SCOUT_API_PLACEHOLDER = '<API URL of this instance>';

describe('Scout onboarding knowledge', () => {
  const prompt = scoutApp.systemPrompt;

  test('gives the exact install and machine commands the Bring-your-own page shows', () => {
    expect(prompt).toContain(constantFromPage('CLI_INSTALL_COMMAND'));
    expect(prompt).toContain(daemonSetupCommandTemplate(SCOUT_API_PLACEHOLDER));
    expect(prompt).not.toMatch(/--instance https:\/\/api\.commonly\.me && commonly daemon register/);
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

  // 2026-10-17: a new person asked for Claude, GPT and Gemini in one group chat
  // and heard that there was no way to bring GPT in.
  test('names Codex as the GPT path into a shared pod, and offers no Gemini path yet', () => {
    expect(prompt).toMatch(/OpenAI's GPT models through Codex/);
    expect(prompt).toMatch(/both join the same pod as teammates in one group chat/);
    expect(prompt).toMatch(/the answer is yes: Claude Code plus Codex/);
    expect(prompt).toMatch(/Gemini can't join yet; do not say when or whether it will/);
    expect(prompt).not.toMatch(/Gemini (through|via|with|on) /);
    // Nothing on the board backs a Gemini promise.
    expect(prompt).not.toMatch(/coming/i);
    // The hosted agent's model is whatever the runtime defaults to, so the
    // prompt names none; the hosted offer's description carries it.
    expect(prompt).not.toMatch(/v4[ -]?flash/i);
  });

  // A dsh visitor was turned away after the adapter shipped and the non-admin
  // macOS walk passed. Keep Scout and the install guide in agreement.
  test('says yes to DeepSeek Harness and gives its attach path', () => {
    expect(prompt).toMatch(/DeepSeek models: yes\. If "Run it here" offers a DeepSeek model/);
    expect(prompt).toMatch(/their own OpenCode pointed at DeepSeek's API, through the OpenCode guide/);
    expect(prompt).toMatch(/DeepSeek Harness \(dsh\) attached as their own agent in a private pod/);
    expect(prompt).toMatch(/other OSs are unverified, not refused/);
    expect(prompt).toMatch(/commonly agent attach dsh --pod <pod-id> --name <name> --env <environment\.json>/);
    expect(prompt).toMatch(/commonly agent run <name>` to answer @mentions/);
    expect(prompt).toContain('docs/cli/dsh.md');
    expect(prompt).not.toMatch(/DeepSeek Harness \(dsh\), cannot connect yet/);
    expect(prompt).toMatch(/name it only when someone asks which model or runtime it uses/);
  });

  // TASK-429: Hermes walked 2026-10-22 (PA-1). The list stays closed: Hermes is
  // added by name, and the list still ends with the refusal to claim anything else.
  test('lists Hermes from the command line, with its attach step and no provider named as walked', () => {
    expect(prompt).toMatch(/OpenCode or dsh through their guides, and Hermes from the command line/);
    expect(prompt).toMatch(/Do not claim any other tool connects\./);
    expect(prompt).toContain('commonly agent attach hermes --pod <pod-id> --name <name>');
    expect(prompt).toMatch(/It needs Hermes 0\.22\.2 exactly/);
    // The adapter fixes --provider openrouter and reads OPENROUTER_API_KEY from the host.
    expect(prompt).toMatch(/an OpenRouter API key \(OPENROUTER_API_KEY\) in the environment/);
    expect(prompt).toMatch(/do not say OpenRouter, or any model provider, was the one it was walked on/);
    expect(prompt).not.toMatch(/walked[^.]*OpenRouter/);
  });

  test('the dsh guide gives the same attach step and the completed macOS walk', () => {
    const guide = fs.readFileSync(path.resolve(__dirname, '../../../../docs/cli/dsh.md'), 'utf8');
    expect(guide).toContain('commonly agent attach dsh --pod <pod-id> --name <name>');
    expect(guide).toContain('commonly.me/v2/pods/<pod-id>');
    expect(guide).toMatch(/DeepSeek Harness 0\.2\.1-rc\.2 was walked with a non-admin Commonly account/);
    expect(guide).toMatch(/macOS using CLI 0\.1\.117/);
    expect(guide).not.toContain('still required before this adapter merges');
  });

  test('connects OpenCode through its guide, never through the connect card', () => {
    expect(prompt).toMatch(/OpenCode, on a model provider they choose .* connects from the command line, not from this page/);
    expect(prompt).toMatch(/do not propose a connect card for it: the card sets up Claude Code or Codex/);
    expect(prompt).toMatch(/Qwen Code and pi are not ready for outside use/);
    expect(prompt).toMatch(/Do not claim any other tool connects/);
  });

  // Linux run 38982219348: a Claude Code listener cannot run on Linux, WSL or
  // Windows (#2288 refuses it), so a connect card for it there is a dead end.
  test('offers a connect card for Claude Code on a Mac only, and says what works elsewhere', () => {
    expect(prompt).toMatch(/Claude Code on a Mac; Codex on Mac or Linux \(WSL included\)/);
    expect(prompt).toMatch(/DeepSeek Harness \(dsh\) through its attach guide, walked on macOS with other OSs unverified/);
    expect(prompt).not.toMatch(/On Linux \(WSL included\), Codex only/);
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

  // Stranger journey 2026-10-26: Scout wrote the Terminal steps and asked
  // "Want me to open that page?" instead of proposing, and no card came.
  test('proposes the connect card once it knows the tool and OS, without asking first', () => {
    expect(prompt).toMatch(
      /Propose the connect card in the same turn you learn both what they run and an OS where it can be connected/,
    );
    expect(prompt).toMatch(/Do not ask whether to: the card is the question/);
    expect(prompt).toMatch(/Do not write the Terminal steps in chat instead of the card/);
    expect(prompt).toMatch(
      /Where the connect card applies, the card is the Terminal half: propose it and give only the MCP line/,
    );
  });

  // A card gets only the MCP line in text, so Codex needs a line of its own:
  // the Claude Code one does not configure Codex.
  test('gives an MCP line for each tool the card connects', () => {
    expect(prompt).toContain('`claude mcp add commonly -e COMMONLY_API_URL=... '
      + '-e COMMONLY_AGENT_TOKEN=... -- npx -y @commonlyai/mcp`');
    expect(prompt).toContain('`codex mcp add commonly --env COMMONLY_API_URL=... '
      + '--env COMMONLY_AGENT_TOKEN=... -- npx -y @commonlyai/mcp`');
    expect(prompt).toMatch(/Give the line for the tool they run/);
  });

  test('cites developer docs that exist in the repository', () => {
    const repo = path.resolve(__dirname, '../../../..');
    for (const doc of [
      'docs/agents/BUILDING_AN_AGENT.md', 'docs/api/openapi.yaml',
      'docs/cli/opencode.md', 'docs/cli/dsh.md',
    ]) {
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
  // Vera on #2297: the welcome's hosted start runs in place on the person's own
  // welcome (services/welcomeHostedStart.ts), so a prompt that says it "opens
  // Bring your own" misdescribes the button they just pressed.
  test('says the welcome\'s hosted start runs in place, with the page only as the fallback', () => {
    expect(prompt).toMatch(/click on it starts a hosted agent right here in their workspace/);
    expect(prompt).toMatch(/only if that cannot run does it open Bring your own/);
    expect(prompt).not.toMatch(/nothing to install", which opens Bring your own/);
  });

  test('quotes no hosted limit from memory, and hands off to Run it here with a button', () => {
    expect(prompt).not.toMatch(/\d+\s+turns (a|per) day/i);
    expect(prompt).toContain('commonly_offer_hosted_agent');
    expect(scoutApp.tools).toContain('commonly_offer_hosted_agent');
    expect(prompt).toMatch(/with no invitation code/);
  });
});

// The hosted model reaches Scout through the offer's description, built from
// the same default a hosted turn runs on, so it follows the deployment the way
// the limits line does (#2237) instead of drifting in a prompt.
describe('the hosted offer names the model a hosted turn runs on', () => {
  const offerDescription = (model) => {
    const saved = process.env.LITELLM_CHAT_MODEL;
    if (model === undefined) delete process.env.LITELLM_CHAT_MODEL;
    else process.env.LITELLM_CHAT_MODEL = model;
    let tools;
    try {
      jest.isolateModules(() => {
        ({ TOOLS: tools } = require('../../../services/nativeRuntimeService'));
      });
    } finally {
      if (saved === undefined) delete process.env.LITELLM_CHAT_MODEL;
      else process.env.LITELLM_CHAT_MODEL = saved;
    }
    return tools.find((tool) => tool.function.name === 'commonly_offer_hosted_agent').function.description;
  };

  test('names DeepSeek V4 Flash for the default model, and says it cannot be changed', () => {
    const description = offerDescription(undefined);
    expect(description).toMatch(/A hosted agent runs on DeepSeek V4 Flash, and the person cannot choose another model today/);
    expect(description).toMatch(/name the model only when they ask which model or runtime it uses/);
  });

  test('follows LITELLM_CHAT_MODEL when the deployment changes it', () => {
    const description = offerDescription('some-other-model');
    expect(description).toMatch(/A hosted agent runs on some-other-model,/);
    expect(description).not.toMatch(/DeepSeek/);
  });
});

// Sam, 2026-10-21: Scout's welcome is in English and doesn't advertise another
// language. If someone writes in another language, Scout answers in it: the
// house rule "Match the user's language" stays in force.
describe('Scout\'s welcome', () => {
  const { SCOUT_WELCOME } = require('../../../config/native-agents/scout');

  test('is in English, with no invitation to write in another language', () => {
    expect(SCOUT_WELCOME).toBe('What would you like to do first?');
    expect(SCOUT_WELCOME).not.toMatch(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uff00-\uffef]/);
  });
});
