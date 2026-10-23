import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2AgentControlSection from '../components/V2AgentControlSection';
import i18n, { i18nReady } from '../../i18n';

beforeAll(async () => { await i18nReady; await i18n.changeLanguage('en'); });

const show = (state: 'revoked' | 'stale' | 'never' | 'connected') => render(
  <MemoryRouter><V2AgentControlSection agentName="local" podId="pod-1" runtimeType="wrapper"
    connection={{ state, lastSeenAt: state === 'stale' ? new Date(Date.now() - 7 * 60000).toISOString() : null }} />
  </MemoryRouter>,
);

it('shows a revoked wrapper key and its one reconnect route', () => {
  show('revoked');
  expect(screen.getByTestId('agent-control-section')).toHaveTextContent('Disconnected: key revoked');
  expect(screen.getByRole('link', { name: 'Reconnect' }))
    .toHaveAttribute('href', '/v2/agents/byo?pod=pod-1&name=local&reconnect=1&mode=machine');
});

it('keeps a never-connected key off the reconnect path', () => {
  show('never');
  expect(screen.getByTestId('agent-control-section')).toHaveTextContent('Not connected yet');
  expect(screen.queryByRole('link', { name: 'Reconnect' })).toBeNull();
});
