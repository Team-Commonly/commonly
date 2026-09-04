import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2InviteModal from '../components/V2InviteModal';
import en from '../../i18n/locales/en.json';
import zhCN from '../../i18n/locales/zh-CN.json';

/**
 * The in-pod "add an agent" path must lead to the flow that works.
 *
 * Connecting an agent the user already runs is the supported path.
 */

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => {
  const actual = jest.requireActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

jest.mock('../hooks/useV2Api', () => ({
  useV2Api: () => ({
    get: jest.fn().mockResolvedValue({ invites: [] }),
    post: jest.fn(), patch: jest.fn(), del: jest.fn(),
  }),
}));

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { _id: 'u1', username: 'sam' } }),
}));

const POD = '6a7d154b0ec237d4b15dd28b';

const open = () => render(
  <MemoryRouter>
    <V2InviteModal open podId={POD} podName="My Workspace" initialTab="agent" onClose={jest.fn()} />
  </MemoryRouter>,
);

describe('the in-pod add-agent path', () => {
  beforeEach(() => jest.clearAllMocks());

  test('the primary action goes to BYO connect, with the pod prefilled', () => {
    open();

    const cta = screen.queryByText(en.inviteModal.connectOwnAgent);
    expect(cta).toBeTruthy();
    fireEvent.click(cta as HTMLElement);

    // `?pod=` — V2AgentBYO reads `pod`, NOT `podId`. Getting this wrong sends
    // the user to an unprefilled form, which is how a two-minute flow becomes
    // a dead end.
    expect(mockNavigate).toHaveBeenCalledWith(`/v2/agents/byo?pod=${POD}`);
  });

});

describe('both locales carry the new primary action', () => {
  test.each([['en', en as any], ['zh-CN', zhCN as any]])('%s', (_l, bundle) => {
    // Two of the users this change is for wrote Chinese.
    expect(bundle.inviteModal.connectOwnAgent).toBeTruthy();
    // The hint must describe connecting your own agent, not picking from a
    // catalog — the sentence is what sets the expectation before the click.
    expect(bundle.inviteModal.agentHint).not.toMatch(/catalog|目录/);
  });
});
