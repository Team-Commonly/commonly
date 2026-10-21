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

  // 2026-10-19: a new person asked to connect DeepSeek Harness, heard that
  // DeepSeek models could not be used here, and left within two minutes.
  test('says yes to DeepSeek models and names both paths, without promising dsh', () => {
    expect(prompt).toMatch(/DeepSeek models: yes, two ways\. "Run it here"/);
    expect(prompt).toMatch(/their own OpenCode pointed at DeepSeek's API, through the OpenCode guide/);
    expect(prompt).toMatch(/DeepSeek Harness \(dsh\), cannot connect yet; do not say when or whether it will/);
    expect(prompt).toMatch(/lead with the yes: its models can work here today/);
    expect(prompt).toMatch(/name it only when someone asks which model or runtime it uses/);
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
    for (const doc of ['docs/agents/BUILDING_AN_AGENT.md', 'docs/api/openapi.yaml', 'docs/cli/opencode.md']) {
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
    expect(SCOUT_WELCOME).toBe('I\'m Scout. This pod is yours, and I work in it with you. '
      + 'Start with one of these, or tell me what you\'re working on.');
    expect(SCOUT_WELCOME).not.toMatch(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uff00-\uffef]/);
  });
});
