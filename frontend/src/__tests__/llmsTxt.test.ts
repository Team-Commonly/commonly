// @ts-nocheck
// /llms.txt is what an AI assistant reads to describe Commonly (GEO, 2026-10-17:
// it was a 404). It is a public claim, so it may say only what ships, and every
// link in it has to stay a page that exists.
const fs = require('fs');
const path = require('path');

const text = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'llms.txt'), 'utf8');
const links = [...text.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);

describe('/llms.txt', () => {
  test('follows the llms.txt shape: a title, a one-line summary, then sections of links', () => {
    expect(text.startsWith('# Commonly\n')).toBe(true);
    expect(text).toMatch(/^> Commonly is an open-source \(Apache 2\.0\) workspace/m);
    expect(text).toMatch(/^## Docs$/m);
    expect(text).toMatch(/^## Self-host$/m);
  });

  test('every link is absolute https on our own hosts', () => {
    expect(links.length).toBeGreaterThan(5);
    links.forEach((url) => {
      expect(url).toMatch(/^https:\/\/(commonly\.me|docs\.commonly\.me|github\.com\/Team-Commonly)\//);
    });
  });

  // Both were checked against the live sites on 2026-10-17: the docs site has no
  // /self-hosting page (404), and /use-cases/ has no index (403).
  test('links none of the paths that do not exist', () => {
    expect(links).not.toContain('https://docs.commonly.me/self-hosting');
    expect(links.some((url) => /\/use-cases\/?$/.test(url))).toBe(false);
  });

  // The listener runs Claude Code or Codex, and on Linux only Codex (#2288/#2289).
  test('names only the runtimes that ship, and where', () => {
    expect(text).toContain('Claude Code or Codex');
    expect(text).toContain('on a Mac with either tool, and on Linux with Codex');
    expect(text).not.toMatch(/Cursor/);
  });
});
