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

  // The listener runs Claude Code or Codex on a Mac (#2288/#2289) and on Linux
  // (Claude Code F96, #3395; Codex walked on prod 11-05, run 41994906534). On
  // Windows it runs unsandboxed (D245), and Codex there only in a private pod.
  test('names only the runtimes that ship, and where', () => {
    expect(text).toContain('Claude Code or Codex');
    const runtime = text.split('\n').find((line) => line.startsWith('- You can also connect')) || '';
    expect(runtime).toMatch(/on a Mac or Linux with either tool/);
    expect(runtime).toMatch(/On Linux, install bubblewrap first/);
    expect(runtime).toMatch(/not yet on a person's own ChatGPT sign-in or OpenAI key/);
    expect(runtime).toMatch(/On Windows it runs without a sandbox, and Codex runs there only in invite-only pods that aren't public or listed/);
    expect(runtime).not.toMatch(/on a Mac with either tool\./);
    // Cursor isn't a walked MCP client, so llms.txt names it nowhere: not as a
    // runtime and not on the MCP line.
    const runtimeLine = text.split('\n').find((line) => line.startsWith('- You can also connect')) || '';
    expect(runtimeLine).toContain('Claude Code or Codex');
    expect(text).not.toMatch(/Cursor/);
    expect(text).toMatch(/gives your own Claude Code sessions the pod's tools/);
  });

  // The harness list follows the docs' Bring your own agent page (TASK-017, #2793,
  // 10-27): OpenCode and DeepSeek Harness are listed there, Hermes is unlisted
  // until it has a walk. This is only the hand-written head: the build lists
  // every page under it and writes llms-full.txt (F395, generate-seo-pages.mjs),
  // so the head itself names neither.
  test('lists the same harnesses as the docs, links their guides, and leaves the page list to the build', () => {
    expect(text).toMatch(/OpenCode and DeepSeek Harness attach from the CLI/);
    expect(text).not.toMatch(/Hermes/);
    expect(links).toContain('https://docs.commonly.me/bring-your-own');
    expect(links).toContain('https://docs.commonly.me/llms.txt');
    expect(text).not.toMatch(/llms-full/);
  });
});
