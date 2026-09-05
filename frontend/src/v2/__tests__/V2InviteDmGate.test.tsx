// @ts-nocheck
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import V2Layout from '../components/V2Layout';

let mockPodType = 'chat';

jest.mock('../hooks/useV2Pods', () => ({
  useV2Pods: () => ({
    pods: [{ _id: 'pod-1', name: 'Room', type: mockPodType }],
    loading: false,
    error: null,
    refresh: jest.fn(),
    createPod: jest.fn(),
    deletePod: jest.fn(),
    patchLastMessage: jest.fn(),
  }),
}));

jest.mock('../hooks/useV2PodDetail', () => ({
  useV2PodDetail: () => ({
    pod: { _id: 'pod-1', name: 'Room', type: mockPodType },
    members: [],
    messages: [],
    agents: [],
    loading: false,
    error: null,
    refresh: jest.fn(),
    sendMessage: jest.fn(),
  }),
}));

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { _id: 'human-1', username: 'new-human' } }),
}));

jest.mock('../components/V2NavRail', () => () => null);
jest.mock('../components/V2PodsSidebar', () => () => null);
jest.mock('../components/V2Inspector', () => () => null);
jest.mock('../components/V2InviteModal', () => function MockV2InviteModal({ open, initialTab }) {
  return open ? <div data-testid="invite-modal-tab">{initialTab}</div> : null;
});
jest.mock('../components/V2FirstRunHero', () => () => null);
jest.mock('../components/V2Thread', () => function MockV2Thread({ onOpenInvite }) {
  return (
    <div>
      {onOpenInvite && (
        <>
          <button type="button" onClick={() => onOpenInvite()}>Invite</button>
          <button type="button" onClick={() => onOpenInvite('agent')}>Add agent</button>
        </>
      )}
    </div>
  );
});

const renderLayout = () => render(
  <MemoryRouter initialEntries={['/v2/pods/pod-1']}>
    <Routes>
      <Route path="/v2/pods/:podId" element={<V2Layout selectionMode="param" />} />
    </Routes>
  </MemoryRouter>,
);

describe('V2 invite affordance gating', () => {
  afterEach(() => {
    localStorage.clear();
  });

  test.each(['agent-room', 'agent-dm'])('hides Invite for %s pods', (podType) => {
    mockPodType = podType;
    renderLayout();
    expect(screen.queryByRole('button', { name: 'Invite' })).not.toBeInTheDocument();
  });

  test.each(['chat', 'agent-admin'])('keeps Invite available for %s pods', (podType) => {
    mockPodType = podType;
    renderLayout();
    expect(screen.getByRole('button', { name: 'Invite' })).toBeInTheDocument();
  });

  test('passes the starter action through to the modal agent tab', () => {
    mockPodType = 'chat';
    renderLayout();

    fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
    expect(screen.getByTestId('invite-modal-tab')).toHaveTextContent('agent');
  });
});
