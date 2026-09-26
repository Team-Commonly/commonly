// @ts-nocheck
import fs from 'fs';
import path from 'path';
import React from 'react';
import { createRoot } from 'react-dom/client';
import * as TestUtils from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import ApiDevPage from './ApiDevPage';

// Mock the useAppContext hook
jest.mock('../context/AppContext', () => ({
  useAppContext: () => ({
    user: null,
    token: null,
  }),
}));

let container;
let root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  root.unmount();
  container.remove();
  container = null;
});

const renderApiDevPage = async () => {
  await TestUtils.act(async () => {
    root.render(
      <MemoryRouter>
        <ApiDevPage />
      </MemoryRouter>
    );
  });
};

test('renders API Dev Console title', async () => {
  await renderApiDevPage();
  expect(container.textContent).toContain('API Dev Console');
});

test('renders authentication section', async () => {
  await renderApiDevPage();
  expect(container.textContent).toContain('Authentication');
});

test('renders posts section', async () => {
  await renderApiDevPage();
  expect(container.textContent).toContain('Posts');
});

test('renders integrations section', async () => {
  await renderApiDevPage();
  expect(container.textContent).toContain('Integrations');
});

test('renders warning when not logged in', async () => {
  await renderApiDevPage();
  expect(container.textContent).toContain('You are not logged in');
});

test('component renders without crashing when user is not logged in', async () => {
  await renderApiDevPage();
  expect(container.textContent).toContain('API Dev Console');
}); 

// This page is the API's own documentation, so its examples are a published
// contract: a caller who follows one must not be told to send a key the same
// route refuses. The catalog publishes `manifest.requiredConfig` MINUS every
// server-owned key (`backend/integrations/catalog.ts` `publishedRequirement`,
// TASK-140) — Slack's predicate is `['botTokenRef','chatId']` and Telegram's is
// `['chatId']`, both server-owned, so both publish `[]`, while Discord's
// `['serverId','channelId','botToken']` publishes the two a caller supplies.
// The example advertised the pre-TASK-140 list, whose `channelId` was never a
// Slack field at all (wren 74256; connector-ops 74319).
test('the catalog example publishes only keys a caller may send', async () => {
  await renderApiDevPage();
  const text = container.textContent;

  expect(text).toMatch(/"id": "slack",\s*"requiredConfig": \[\]/);
  expect(text).toMatch(
    /"id": "discord",\s*"requiredConfig": \[[\s\S]{0,120}?"serverId"[\s\S]{0,60}?"channelId"/
  );
  // The retired list, as one string. `botToken` is the instance's and
  // `signingSecret` is stripped from a body, so a client that sent them was
  // answered with `server_owned_config_key`.
  expect(text).not.toMatch(/"botToken",\s*"signingSecret"/);
});

// Layout guard for TASK-143. jsdom has no layout engine, so it cannot see this
// bug in either of the two ways it goes wrong: with no break opportunity the
// path held the summary row wider than its own box and the accordion's
// `overflow: hidden` clipped it (16 of 20 rows at 390x900, worst 135px); with
// `overflow-wrap: anywhere` and no floor the row squeezed the path into a
// column of single glyphs instead (9px wide, 33 lines, a 776px row). Both were
// measured in Chromium on the live page; 0 of 20 rows clip by 700px, so the
// narrow-width rule is cut at 768px. Only declarations can be pinned here --
// including the class name the CSS rule needs on the Box, since a rule that
// matches nothing would pass a CSS-only guard.
test('gives the endpoint path its own line instead of squeezing or clipping it (TASK-143)', () => {
  const css = fs.readFileSync(path.join(__dirname, 'ApiDevPage.css'), 'utf8');
  const blockAfter = (src, sel) => {
    const i = src.indexOf(`${sel} {`);
    expect(i).toBeGreaterThan(-1);
    return src.slice(i, src.indexOf('}', i));
  };

  // Last-resort break, for a path wider than the line it was given.
  expect(blockAfter(css, '.api-dev-endpoint-path')).toContain('overflow-wrap: anywhere');

  const media = css.indexOf('@media (max-width: 767px)');
  expect(media).toBeGreaterThan(-1);
  const narrow = css.slice(media);
  // The row wraps, so the siblings move down rather than squeezing the path...
  expect(blockAfter(narrow, '.api-dev-accordion-row')).toContain('flex-wrap: wrap');
  // ...and it is the path that gets the whole line, not the description or badge.
  expect(blockAfter(narrow, '.api-dev-endpoint-path')).toContain('flex: 1 1 100%');
  // The rule targets the flex Box by class, so the class has to be on it.
  const tsx = fs.readFileSync(path.join(__dirname, 'ApiDevPage.tsx'), 'utf8');
  expect(tsx).toContain('className="api-dev-accordion-row"');
});
