// @ts-nocheck
// /llms.txt is what an AI assistant reads to describe Commonly (GEO, 2026-10-17:
// it was a 404). It is a public claim, so it may say only what ships, and every
// link in it has to stay a page that exists.
const fs = require('fs');
const path = require('path');

const text = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'llms.txt'), 'utf8');
// Markdown links AND bare URLs in the prose: the contract is "every link in it
// stays a page that exists", and a bare URL is as quotable as a linked one
// (sprint-review on #2301: bare dead or off-host URLs passed every assertion).
const markdownLinks = [...text.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
const bareLinks = [...text.matchAll(/https?:\/\/[^\s)\]>"']+/g)]
  .filter((m) => text.slice(Math.max(0, m.index - 2), m.index) !== '](')
  .map((m) => m[0].replace(/[.,;:]+$/, ''));
const allLinks = [...markdownLinks, ...bareLinks];
const links = [...new Set(allLinks)];

describe('/llms.txt', () => {
  test('follows the llms.txt shape: a title, a one-line summary, then sections of links', () => {
    expect(text.startsWith('# Commonly\n')).toBe(true);
    expect(text).toMatch(/^> Commonly AI is an open-source \(Apache 2\.0\) workspace/m);
    expect(text).toMatch(/^## Docs$/m);
    expect(text).toMatch(/^## Self-host$/m);
  });

  test('every link is absolute https on our own hosts', () => {
    expect(links.length).toBeGreaterThan(5);
    links.forEach((url) => {
      expect(url).toMatch(/^https:\/\/(commonly\.me|docs\.commonly\.me|github\.com\/Team-Commonly)\//);
    });
  });

  test('lists each URL once', () => {
    expect(new Set(allLinks).size).toBe(allLinks.length);
  });

  // Both were checked against the live sites on 2026-10-17: the docs site has no
  // /self-hosting page (404), and /use-cases/ has no index (403).
  test('links none of the paths that do not exist', () => {
    expect(links).not.toContain('https://docs.commonly.me/self-hosting');
    expect(links.some((url) => /\/use-cases\/?$/.test(url))).toBe(false);
  });

  // "In a few seconds" is measured, and only for the click: QA hosted walk 5
  // timed "Run it here" clicked to provisioned at 2.54 s (install 1.83 +
  // provision 0.63; walk 4: 2.47 s), QA report qa-hosted-oob-5,
  // timing table. Signup to a live agent is 1:10.5 at a person's
  // pace, so no timing claim may be made about signup.
  test('its only timing claim is the measured one: a hosted agent a few seconds after the click', () => {
    const claim = '"Run an agent here" starts a hosted agent in a few seconds';
    expect(text).toContain(claim);
    // With the measured sentence removed, no timing claim may remain. Matched as
    // a duration, so "a second pod" is still fine (sprint-review on #2302).
    const rest = text.replace(claim, '');
    expect(rest).not.toMatch(/\b(\d+|a few|several|within|in) seconds?\b|\bin seconds\b|\binstant(ly)?\b/i);
  });

  // The listener runs Claude Code or Codex on a Mac (#2288/#2289). Linux is cut
  // until a dated walk exists (TASK-016, Lily 10-27): Codex on Linux is unverified.
  test('names only the runtimes that ship, and where', () => {
    expect(text).toContain('Claude Code or Codex');
    expect(text).toContain('on a Mac with either tool.');
    expect(text).not.toMatch(/Linux with Codex/);
    // Cursor ships as an MCP client (agentByo.snippets.cursor), not as a runtime:
    // the ban is on the runtime sentence, not the file (sprint-review on #2302).
    const runtimeLine = text.split('\n').find((line) => line.startsWith('- You can also connect')) || '';
    expect(runtimeLine).toContain('Claude Code or Codex');
    expect(runtimeLine).not.toMatch(/Cursor/);
    expect(text).toMatch(/Claude Code or Cursor sessions the pod's tools/);
  });

  // The harness list follows the docs' Bring your own agent page (TASK-017, #2793,
  // 10-27): OpenCode and DeepSeek Harness are listed there, Hermes is unlisted
  // until it has a walk. The docs' own llms.txt is the fuller index; this file
  // links it rather than shipping an llms-full.txt we do not serve.
  test('lists the same harnesses as the docs, links their guides, and no llms-full', () => {
    expect(text).toMatch(/OpenCode and DeepSeek Harness attach from the CLI/);
    expect(text).not.toMatch(/Hermes/);
    expect(links).toContain('https://docs.commonly.me/bring-your-own');
    expect(links).toContain('https://docs.commonly.me/llms.txt');
    expect(text).not.toMatch(/llms-full/);
  });
});
