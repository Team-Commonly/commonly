import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import V2Playbooks from '../components/V2Playbooks';
import type { Playbook } from '../components/playbookTypes';

const mockGet = jest.fn();
const mockPost = jest.fn();
const mockPut = jest.fn();
const mockApi = { get: mockGet, post: mockPost, put: mockPut };
jest.mock('../hooks/useV2Api', () => ({ useV2Api: () => mockApi }));
jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { _id: 'human', username: 'lily' } }),
}));
const draft: Playbook = {
  id: 'book',
  title: 'Outreach reply',
  sourceText: 'A procedure',
  bindings: { checker: 'agent', sender: 'human' },
  on: false,
  onBy: 'human',
  error: null,
  schedule: null,
  definition: {
    v: 1,
    roles: [
      { key: 'checker', kind: 'agent' },
      { key: 'sender', kind: 'person' },
    ],
    steps: [
      {
        key: 'check',
        title: 'Check the draft',
        role: 'checker',
        do: 'Check and post',
        delivers: 'post',
      },
      {
        key: 'send',
        title: 'Send manually',
        role: 'sender',
        do: 'Send by hand',
        writeGap: 'linkedin',
        approval: { by: 'sender', act: 'actor' },
      },
    ],
    done: [
      { says: 'Approved', check: 'approved', step: 'send' },
      { says: 'Send recorded complete', check: 'done', step: 'send' },
      { says: 'Person sent', check: 'by-person', step: 'send' },
    ],
  },
};
let book: Playbook;
let runs: unknown[];
const show = () =>
  render(
    <MemoryRouter initialEntries={['/v2/pods/pod/playbooks']}>
      <Routes>
        <Route path="/v2/pods/:podId/playbooks" element={<V2Playbooks />} />
      </Routes>
    </MemoryRouter>,
  );
beforeEach(() => {
  jest.clearAllMocks();
  book = JSON.parse(JSON.stringify(draft));
  runs = [];
  mockGet.mockImplementation(async (url: string) => {
    if (url.endsWith('/options'))
      return {
        enabled: true,
        tools: [],
        members: [
          { userId: 'human', handle: 'lily', label: 'Lily', kind: 'person' },
          { userId: 'agent', handle: 'vera', label: 'Vera', kind: 'agent', runtime: 'byo' },
        ],
      };
    if (url.endsWith('/runs')) return { runs };
    return { playbooks: [book] };
  });
  mockPost.mockImplementation(async (_url, body) => {
    book = { ...book, on: body.on };
    return {};
  });
  mockPut.mockImplementation(async () => {
    book = { ...book, on: false };
    return {};
  });
});
test('Off disables Run; a failed On keeps it disabled and shows the server refusal', async () => {
  show();
  await screen.findByText('Lily approves, then sends');
  expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
  mockPost.mockRejectedValueOnce({
    response: { data: { message: 'This tool is no longer granted' } },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Turn On' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('This tool is no longer granted');
  expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
});
test('turn-on submits bindings; Run creates a stable request before the server reply', async () => {
  Object.defineProperty(global.crypto, 'randomUUID', {
    configurable: true,
    value: () => 'stable-run-id',
  });
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Turn On' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled(),
  );
  expect(mockPost).toHaveBeenCalledWith('/api/pods/pod/playbooks/book/state', {
    on: true,
    bindings: draft.bindings,
  });
  fireEvent.click(screen.getByRole('button', { name: 'Run' }));
  fireEvent.change(screen.getByLabelText('Run input'), { target: { value: 'Conversation' } });
  fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
  await waitFor(() =>
    expect(mockPost).toHaveBeenCalledWith('/api/pods/pod/playbooks/book/run', {
      input: 'Conversation',
      requestId: 'stable-run-id',
    }),
  );
});
test('approval alone is independent of done and person evidence; bound human completes through guarded endpoint', async () => {
  book.on = true;
  runs = [
    {
      taskId: 'TASK-1',
      status: 'claimed',
      lastUpdate: 'Needs send',
      steps: [
        {
          taskId: 'TASK-3',
          key: 'send',
          title: 'Send manually',
          status: 'pending',
          guard: 'person',
          ruling: { state: 'approved' },
          completedBy: null,
        },
      ],
    },
  ];
  const { container } = show();
  await screen.findByText('Marked done by Lily');
  const checks = container.querySelector('.v2-playbooks__checks')!;
  expect(checks.children[0]).toHaveTextContent('met');
  expect(checks.children[1]).toHaveTextContent('not yet');
  expect(checks.children[2]).toHaveTextContent('not yet');
  fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
  await waitFor(() =>
    expect(mockPost).toHaveBeenCalledWith('/api/v1/tasks/pod/TASK-3/complete', {}),
  );
});
test('awaiting approval exposes no completion action and refuses editor during an open run', async () => {
  runs = [
    {
      taskId: 'TASK-1',
      status: 'blocked',
      lastUpdate: 'Awaiting',
      steps: [
        {
          taskId: 'TASK-3',
          key: 'send',
          title: 'Send manually',
          status: 'pending',
          guard: 'person',
          ruling: { state: 'awaiting' },
          completedBy: null,
        },
      ],
    },
  ];
  show();
  await screen.findByText('Marked done by Lily');
  expect(screen.queryByRole('button', { name: 'Mark done' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save Off' })).toBeDisabled();
});
test('editing On saves Off with structured definition and source', async () => {
  book.on = true;
  show();
  await screen.findByDisplayValue('Outreach reply');
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Edited reply' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Off' }));
  await waitFor(() =>
    expect(mockPut).toHaveBeenCalledWith(
      '/api/pods/pod/playbooks/book',
      expect.objectContaining({
        title: 'Edited reply',
        definition: draft.definition,
        sourceText: 'A procedure',
      }),
    ),
  );
  expect(await screen.findByRole('button', { name: 'Turn On' })).toBeEnabled();
});
