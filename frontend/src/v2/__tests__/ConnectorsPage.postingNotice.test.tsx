// @ts-nocheck
// Connectors page: the notice that explains why a seat cannot post. The pod
// roster marks a seat whose connector grants reach more than one of its pods
// (the runtime then refuses its writes everywhere), and marks a census it could
// not run. The page names the seats, never the pods, and never reads an
// unknown status as "posting works". A seat whose grants reach exactly one of
// its several pods can post only there, and gets its own line.
import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import { axios, mockApi, renderPage, pageReady } from '../__testkit__/connectorsKit';

jest.mock('axios', () => require('../__testkit__/axiosMock').axiosFactory());

const pods = [
  { _id: 'p1', name: 'Launch pod', type: 'chat' },
  { _id: 'p2', name: 'Ops', type: 'chat' },
];
const scout = { name: 'scout', displayName: 'Scout', userId: 'a1' };
const BLOCKED = /cannot post in any pod while connectors reach more than one of their pods/;
const UNKNOWN = /Could not check whether connector grants limit agent posting/;
const ONE_POD = /can post only in one of their pods while that pod has connector access/;

afterEach(() => jest.restoreAllMocks());

describe('Connectors page: posting notice', () => {
  it('names a blocked seat once, across every pod that lists it, and no pod', async () => {
    mockApi({
      pods,
      seats: {
        p1: [{ ...scout, runtimeNarrowedByMultipleGrantPods: true }],
        p2: [{ ...scout, runtimeNarrowedByMultipleGrantPods: true }, { name: 'wren', displayName: 'Wren', userId: 'a2' }],
      },
    });
    renderPage();

    const note = await screen.findByText(BLOCKED);
    expect(note).toHaveAttribute('role', 'status');
    expect(note.textContent.startsWith('Scout cannot post')).toBe(true);
    expect(note).not.toHaveTextContent('Wren');
    expect(note).not.toHaveTextContent(/Launch pod|Ops|p1|p2/);
    expect(screen.queryByText(UNKNOWN)).not.toBeInTheDocument();
  });

  it('names a seat limited to one pod on its own line, apart from a blocked seat, and no pod', async () => {
    mockApi({
      pods,
      seats: {
        p1: [{ ...scout, runtimeNarrowedByMultipleGrantPods: true }, { name: 'wren', displayName: 'Wren', userId: 'a2', runtimeNarrowedToOnePod: true }],
        p2: [{ name: 'wren', displayName: 'Wren', userId: 'a2', runtimeNarrowedToOnePod: true }],
      },
    });
    renderPage();

    const onePod = await screen.findByText(ONE_POD);
    expect(onePod).toHaveAttribute('role', 'status');
    expect(onePod.textContent.startsWith('Wren can post only')).toBe(true);
    expect(onePod).not.toHaveTextContent(/Scout|Launch pod|Ops|p1|p2/);
    expect(screen.getByText(BLOCKED)).not.toHaveTextContent('Wren');
  });

  it('names two instances of one agent separately when neither has a user row', async () => {
    mockApi({
      pods,
      seats: { p1: [
        { name: 'openclaw', instanceId: 'aria', displayName: 'Aria', userId: null, runtimeNarrowedByMultipleGrantPods: true },
        { name: 'openclaw', instanceId: 'pixel', displayName: 'Pixel', userId: null, runtimeNarrowedByMultipleGrantPods: true },
      ] },
    });
    renderPage();

    expect(await screen.findByText(BLOCKED)).toHaveTextContent(/^Aria, Pixel cannot post/);
  });

  it('says the status is unknown when a roster read fails', async () => {
    mockApi({
      pods,
      seats: { p1: [scout] },
      route: (url) => (url === '/api/registry/pods/p2/agents' ? Promise.reject(new Error('roster unavailable')) : undefined),
    });
    renderPage();

    expect(await screen.findByText(UNKNOWN)).toHaveAttribute('role', 'status');
    expect(screen.queryByText(BLOCKED)).not.toBeInTheDocument();
  });

  it('says the status is unknown when the pod list cannot be read', async () => {
    mockApi({ pods: new Error('pod list unavailable') });
    renderPage();

    expect(await screen.findByText(UNKNOWN)).toHaveAttribute('role', 'status');
  });

  it('says the status is unknown when the pod list read returns something other than a list', async () => {
    mockApi({ pods: { error: 'unexpected body' } });
    renderPage();

    expect(await screen.findByText(UNKNOWN)).toHaveAttribute('role', 'status');
  });

  it('says the status is unknown when the roster could not run its grant census', async () => {
    mockApi({ pods, seats: { p1: [{ ...scout, runtimeNarrowingUnavailable: true }] } });
    renderPage();

    expect(await screen.findByText(UNKNOWN)).toBeInTheDocument();
  });

  it('shows neither notice when every roster read succeeds and nothing is narrowed', async () => {
    mockApi({ pods, seats: { p1: [scout], p2: [scout] } });
    renderPage();

    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/registry/pods/p2/agents', expect.anything()));
    await pageReady();
    expect(screen.queryByText(BLOCKED)).not.toBeInTheDocument();
    expect(screen.queryByText(ONE_POD)).not.toBeInTheDocument();
    expect(screen.queryByText(UNKNOWN)).not.toBeInTheDocument();
  });
});
