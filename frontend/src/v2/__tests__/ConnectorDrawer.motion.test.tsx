// @ts-nocheck
// The connector drawer slides in from the right and back out (the motion spec):
// on close it stays mounted, inert, until its exit animation ends, and it can
// never be stranded there.
import React from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { mockApi, renderPage, findDrawer, clickTile } from '../__testkit__/connectorsKit';
import { EXIT_SAFETY_MS } from '../utils/motion';

jest.mock('axios', () => require('../__testkit__/axiosMock').axiosFactory());

const pods = [{ _id: 'p1', name: 'Rewire Live Demo', type: 'chat', members: [] }];
const liveSlack = {
  installableId: 'slack', label: 'Slack', description: 'Slack copy.', available: true, offered: true,
  installation: { status: 'active', updatedAt: new Date().toISOString(), boundPodId: 'p1', components: [] },
  integration: {
    _id: 'i-live', installationId: 'install-slack-u1', type: 'slack', status: 'connected', scope: 'user', isActive: true,
    createdAt: new Date(Date.now() - 3_600_000).toISOString(), updatedAt: new Date().toISOString(),
    config: { chatTitle: 'Rewire crew', liveRelay: true, gates: {} }, podId: 'p1',
  },
};

const realMatchMedia = window.matchMedia;
const realGetComputedStyle = window.getComputedStyle;
let reduce = false;

beforeEach(() => {
  jest.clearAllMocks();
  reduce = false;
  window.history.replaceState({}, '', '/v2/connectors');
  window.matchMedia = jest.fn().mockImplementation((query) => ({
    matches: query.includes('reduced-motion') ? reduce : false,
    media: query,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  }));
});

afterEach(() => {
  window.matchMedia = realMatchMedia;
  window.getComputedStyle = realGetComputedStyle;
});

// jsdom runs no animations; report the ones connectors.css would apply.
const withDrawerAnimations = () => {
  window.getComputedStyle = (node, pseudo) => new Proxy(realGetComputedStyle(node, pseudo), {
    get(target, key) {
      if (key === 'animationName' && node.classList?.contains('v2-cx-drawer')) {
        return node.classList.contains('is-leaving') ? 'v2-cx-drawer-out' : 'v2-cx-drawer-in';
      }
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
};

const openSlack = async () => {
  mockApi({ installables: [liveSlack], pods });
  renderPage();
  await clickTile('Slack');
  return findDrawer('Slack');
};
const drawerNode = () => document.querySelector('section.v2-cx-drawer');

describe('connector drawer motion', () => {
  it('opens without the leaving state and, on close, stays mounted and inert until its slide out ends', async () => {
    withDrawerAnimations();
    const drawer = await openSlack();
    expect(drawer).not.toHaveClass('is-leaving');
    expect(drawer).not.toHaveAttribute('inert');

    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    expect(drawerNode()).toHaveClass('is-leaving');
    expect(drawerNode()).toHaveAttribute('inert');
    // Leaving, it is out of the accessibility tree: the page reads as closed.
    expect(screen.queryByRole('region', { name: 'Slack' })).toBeNull();

    fireEvent.animationEnd(drawerNode());
    expect(drawerNode()).toBeNull();
  });

  it('unmounts after the safety net when no animationend arrives', async () => {
    withDrawerAnimations();
    const drawer = await openSlack();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    expect(drawerNode()).not.toBeNull();
    await waitFor(() => expect(drawerNode()).toBeNull(), { timeout: EXIT_SAFETY_MS + 500 });
  });

  it('closes at once under reduced motion', async () => {
    withDrawerAnimations();
    reduce = true;
    const drawer = await openSlack();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    expect(drawerNode()).toBeNull();
  });

  it('closes at once when no exit animation applies at all', async () => {
    const drawer = await openSlack();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    expect(drawerNode()).toBeNull();
  });
});
