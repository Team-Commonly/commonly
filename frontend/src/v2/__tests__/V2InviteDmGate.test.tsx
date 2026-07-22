// @ts-nocheck
import React from 'react';
import { render, screen } from '@testing-library/react';
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

jest.mock('../components/V2NavRail', () => () => null);
jest.mock('../components/V2PodsSidebar', () => () => null);
jest.mock('../components/V2PodInspector', () => () => null);
jest.mock('../components/V2InviteModal', () => () => null);
jest.mock('../components/V2FirstRunHero', () => () => null);
jest.mock('../components/V2PodChat', () => function MockV2PodChat({ onOpenInvite }) {
  return <div>{onOpenInvite && <button type="button">Invite</button>}</div>;
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
});
