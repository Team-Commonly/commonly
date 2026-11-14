// @ts-nocheck
// F498: a pod's conventions (F124) are read by every agent turn, but the pod
// UI had no way to see or set them. The inspector shows them to members and
// lets the pod's creator edit them, against the API's revision check.
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import V2PodConventions from '../components/V2PodConventions';
import { AuthContext } from '../../context/AuthContext';

const auth = { currentUser: { _id: 'u1' }, user: { _id: 'u1' }, token: 't', loading: false, error: null, isAuthenticated: true };
const mount = (ui) => render(<AuthContext.Provider value={auth}>{ui}</AuthContext.Provider>);

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(), patch: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: { request: { use: jest.fn(), eject: jest.fn() }, response: { use: jest.fn(), eject: jest.fn() } },
  };
  return { __esModule: true, default: mock, ...mock };
});
const axios = jest.requireMock('axios').default;

const read = (text, { canEdit = false, revision = 1, label = 'Ann' } = {}) => ({
  data: {
    podId: 'p1', revision,
    conventions: text === null ? null : { text, updatedAt: new Date().toISOString(), updatedBy: { userId: 'a', label } },
    permissions: { canEdit },
  },
});

afterEach(() => jest.clearAllMocks());

test('a member reads the text and who set it, with no edit control', async () => {
  axios.get.mockResolvedValueOnce(read('Reply in threads.\nCheck CI before posting.'));
  mount(<V2PodConventions podId="p1" />);
  expect(await screen.findByTestId('pod-conventions-text')).toHaveTextContent('Reply in threads. Check CI before posting.');
  expect(screen.getByText(/Set by Ann/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
});

test('a member of a pod with none is told the creator can add them', async () => {
  axios.get.mockResolvedValueOnce(read(null));
  mount(<V2PodConventions podId="p1" />);
  expect(await screen.findByText(/No conventions yet/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
});

test('the creator writes them; the save sends the read revision and shows the saved text', async () => {
  axios.get.mockResolvedValueOnce(read(null, { canEdit: true, revision: 0 }));
  axios.patch.mockResolvedValueOnce(read('Reply in threads.', { canEdit: true, revision: 1, label: 'You' }));
  mount(<V2PodConventions podId="p1" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Write conventions' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Conventions' }), { target: { value: '  Reply in threads.  ' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
  expect(axios.patch).toHaveBeenCalledWith('/api/pods/p1/conventions', { expectedRevision: 0, text: 'Reply in threads.' }, expect.anything());
  expect(await screen.findByTestId('pod-conventions-text')).toHaveTextContent('Reply in threads.');
  expect(screen.queryByRole('textbox')).toBeNull();
});

test('clearing every character saves null', async () => {
  axios.get.mockResolvedValueOnce(read('Old rule', { canEdit: true, revision: 3 }));
  axios.patch.mockResolvedValueOnce(read(null, { canEdit: true, revision: 4 }));
  mount(<V2PodConventions podId="p1" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Conventions' }), { target: { value: '   ' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
  expect(axios.patch).toHaveBeenCalledWith('/api/pods/p1/conventions', { expectedRevision: 3, text: null }, expect.anything());
});

test('a conflict keeps the draft, shows the saved version, and the next save is against it', async () => {
  axios.get.mockResolvedValueOnce(read('v1', { canEdit: true, revision: 1 }));
  axios.patch.mockRejectedValueOnce({ response: { status: 409, data: { code: 'CONVENTIONS_CONFLICT', current: read('v2 from Bo', { revision: 2, label: 'Bo' }).data } } });
  axios.patch.mockResolvedValueOnce(read('my draft', { canEdit: true, revision: 3 }));
  mount(<V2PodConventions podId="p1" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Conventions' }), { target: { value: 'my draft' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
  expect(await screen.findByRole('alert')).toHaveTextContent('Bo changed these while you were editing');
  expect(screen.getByTestId('pod-conventions-latest')).toHaveTextContent('v2 from Bo');
  expect(screen.getByRole('textbox', { name: 'Conventions' })).toHaveValue('my draft');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
  expect(axios.patch).toHaveBeenLastCalledWith('/api/pods/p1/conventions', { expectedRevision: 2, text: 'my draft' }, expect.anything());
});

test('past 4000 characters, counted in code points, Save is off and the count says how far over', async () => {
  axios.get.mockResolvedValueOnce(read(null, { canEdit: true, revision: 0 }));
  mount(<V2PodConventions podId="p1" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Write conventions' }));
  const box = screen.getByRole('textbox', { name: 'Conventions' });
  fireEvent.change(box, { target: { value: '😀'.repeat(4000) } });
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  expect(screen.getByText('0 characters left')).toBeInTheDocument();
  fireEvent.change(box, { target: { value: '😀'.repeat(4001) } });
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(screen.getByText('1 character over')).toBeInTheDocument();
});

test('Cancel drops the draft and goes back to the saved text', async () => {
  axios.get.mockResolvedValueOnce(read('Keep this', { canEdit: true }));
  mount(<V2PodConventions podId="p1" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Conventions' }), { target: { value: 'scratch' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByTestId('pod-conventions-text')).toHaveTextContent('Keep this');
  expect(axios.patch).not.toHaveBeenCalled();
});

test('a server without conventions (404) renders nothing', async () => {
  axios.get.mockRejectedValueOnce({ response: { status: 404 } });
  const { container } = mount(<V2PodConventions podId="p1" />);
  await waitFor(() => expect(axios.get).toHaveBeenCalled());
  await waitFor(() => expect(container.querySelector('[data-testid=pod-conventions]')).toBeNull());
});

test('a save that finishes after a pod switch stays out of the new pod', async () => {
  let finishSave;
  axios.get.mockResolvedValueOnce(read('A rules', { canEdit: true, revision: 1 }));
  axios.patch.mockReturnValueOnce(new Promise((resolve) => { finishSave = resolve; }));
  const view = mount(<V2PodConventions podId="pA" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Conventions' }), { target: { value: 'A draft' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
  axios.get.mockResolvedValueOnce(read('B rules', { canEdit: true, revision: 7, label: 'Bo' }));
  view.rerender(<AuthContext.Provider value={auth}><V2PodConventions podId="pB" /></AuthContext.Provider>);
  expect(await screen.findByTestId('pod-conventions-text')).toHaveTextContent('B rules');
  await act(async () => { finishSave(read('A draft', { canEdit: true, revision: 2 })); });
  expect(screen.getByTestId('pod-conventions-text')).toHaveTextContent('B rules');
  expect(screen.getByText(/Set by Bo/)).toBeInTheDocument();
});

test('focus moves into the field on Edit and back to Edit after Save or Cancel', async () => {
  axios.get.mockResolvedValueOnce(read('Rules', { canEdit: true, revision: 1 }));
  axios.patch.mockResolvedValueOnce(read('New rules', { canEdit: true, revision: 2 }));
  mount(<V2PodConventions podId="p1" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  expect(screen.getByRole('textbox', { name: 'Conventions' })).toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByRole('button', { name: 'Edit' })).toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
  expect(await screen.findByRole('button', { name: 'Edit' })).toHaveFocus();
});

test('a 409 without the saved version re-reads it and keeps the draft', async () => {
  axios.get.mockResolvedValueOnce(read('v1', { canEdit: true, revision: 1 }));
  axios.patch.mockRejectedValueOnce({ response: { status: 409, data: { code: 'CONVENTIONS_CONFLICT' } } });
  axios.get.mockResolvedValueOnce(read('v5 from Cy', { canEdit: true, revision: 5, label: 'Cy' }));
  axios.patch.mockResolvedValueOnce(read('mine', { canEdit: true, revision: 6 }));
  mount(<V2PodConventions podId="p1" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Conventions' }), { target: { value: 'mine' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
  expect(await screen.findByTestId('pod-conventions-latest')).toHaveTextContent('v5 from Cy');
  expect(screen.getByRole('textbox', { name: 'Conventions' })).toHaveValue('mine');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
  expect(axios.patch).toHaveBeenLastCalledWith('/api/pods/p1/conventions', { expectedRevision: 5, text: 'mine' }, expect.anything());
});
