import React from 'react';
import ReactDOM from 'react-dom/client';
import * as TestUtils from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import PodContextDevPage from './PodContextDevPage';

const axios = require('axios').default;

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));

jest.mock('../context/AuthContext', () => ({
  useAuth: () => ({ token: 'token-1' }),
}));

let container;
let root;

beforeEach(() => {
  jest.resetAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
});

afterEach(() => {
  root.unmount();
  container.remove();
  container = null;
});

test('loads pods and fetches pod context with LLM skill params', async () => {
  axios.get
    .mockResolvedValueOnce({
      data: [
        { _id: 'pod-1', name: 'Incident Pod' },
      ],
    })
    .mockResolvedValueOnce({
      data: {
        pod: {
          id: 'pod-1',
          name: 'Incident Pod',
          description: 'Handles incidents',
          type: 'chat',
        },
        task: 'incident runbook',
        skillModeUsed: 'llm',
        skillWarnings: [],
        stats: {
          summaries: 1,
          assets: 1,
          tags: 2,
          skills: 1,
        },
        skills: [
          {
            _id: 'skill-1',
            title: 'Skill: Incident Triage',
            content: '### Incident Triage\n\n**TL;DR**\nFollow the runbook.',
            tags: ['incident', 'triage'],
            metadata: { score: 9.1, skillName: 'Incident Triage' },
          },
        ],
        tags: [
          { tag: 'incident', count: 3 },
        ],
        summaries: [
          {
            _id: 'summary-1',
            title: 'Incident alignment',
            createdAt: '2026-01-20T10:00:00.000Z',
            content: '## Summary Content\n\nImportant incident detail.',
            tags: ['incident'],
            relevanceScore: 1,
          },
        ],
        assets: [
          {
            _id: 'asset-1',
            title: 'Discord Summary',
            createdAt: '2026-01-20T11:00:00.000Z',
            tags: ['incident'],
            relevanceScore: 1,
          },
        ],
      },
    });

  await TestUtils.act(async () => {
    root.render(
      <MemoryRouter>
        <PodContextDevPage />
      </MemoryRouter>,
    );
  });

  expect(axios.get).toHaveBeenCalledWith('/api/pods', {
    headers: { Authorization: 'Bearer token-1' },
  });

  const button = Array.from(container.querySelectorAll('button')).find(
    (btn) => btn.textContent?.includes('Fetch Context'),
  );

  expect(button).toBeTruthy();

  await TestUtils.act(async () => {
    TestUtils.Simulate.click(button);
  });

  const summaryToggle = container.querySelector('input[type="checkbox"]');
  expect(summaryToggle).toBeTruthy();

  await TestUtils.act(async () => {
    TestUtils.Simulate.change(summaryToggle, { target: { checked: true } });
  });

  expect(axios.get).toHaveBeenLastCalledWith('/api/pods/pod-1/context', {
    headers: { Authorization: 'Bearer token-1' },
    params: {
      task: undefined,
      summaryLimit: '6',
      assetLimit: '12',
      tagLimit: '16',
      skillLimit: '6',
      skillMode: 'llm',
      skillRefreshHours: '6',
    },
  });

  expect(container.textContent).toContain('Pod Context Inspector');
  expect(container.textContent).toContain('Skills (LLM Markdown)');
  expect(container.textContent).toContain('Skill Mode: llm');
  expect(container.textContent).toContain('Incident Triage');
  expect(container.textContent).toContain('Top Tags');
  expect(container.textContent).toContain('incident (3)');
  expect(container.textContent).toContain('Summaries: 1');
  expect(container.textContent).toContain('Skills: 1');
  expect(container.textContent).toContain('Summary Content');
  expect(container.textContent).toContain('Important incident detail.');
});
