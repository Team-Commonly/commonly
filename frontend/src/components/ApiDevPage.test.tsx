// @ts-nocheck
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
