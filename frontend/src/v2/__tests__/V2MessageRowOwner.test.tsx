import React from 'react';
import { TextEncoder } from 'util';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '../../i18n';
import V2MessageRow from '../components/V2MessageRow';

Object.assign(global, { TextEncoder });

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { username: 'viewer' } }),
}));

// F655: an agent's message says whose agent it is, so a teammate reading the
// room can tell who answers for it. The pod read supplies the owner's name;
// nobody's id reaches the page.
const AGENT_ID = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const message = (overrides: Record<string, unknown> = {}) => ({
  id: 'm-1', pod_id: 'pod-1', user_id: AGENT_ID, message_type: 'text',
  content: 'Fixed the redirect.', created_at: '2026-11-26T21:00:00.000Z',
  user: { username: 'openclaw-nova', isBot: true },
  ...overrides,
});
const owners = (entry: { name: string; mine?: boolean }) => new Map([[AGENT_ID, entry]]);
const head = () => document.querySelector('.v2-msg__head');

describe('V2MessageRow owner byline', () => {
  afterEach(() => i18n.changeLanguage('en'));

  const part = (name: string) => document.querySelector(`.v2-msg__owner-${name}`);

  it("shows the owner beside an agent's name, the name and the suffix apart", () => {
    render(<MemoryRouter><V2MessageRow message={message()} agentOwners={owners({ name: 'Lily' })} /></MemoryRouter>);
    expect(head()).toHaveTextContent("Lily's agent");
    expect(document.querySelector('.v2-msg__owner')).toHaveTextContent("Lily's agent");
    // Only the name can be cut; the suffix stays whole.
    expect(part('name')).toHaveTextContent(/^Lily$/);
    expect(part('suffix')?.textContent).toBe("'s agent");
    expect(screen.getByText('Lily')).toHaveClass('v2-msg__owner-name');
  });

  it('says it in Chinese with the glossary term, keeping the half-width space', async () => {
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    render(<MemoryRouter><V2MessageRow message={message()} agentOwners={owners({ name: 'Lily' })} /></MemoryRouter>);
    expect(head()).toHaveTextContent('Lily 的智能体');
    expect(part('name')).toHaveTextContent(/^Lily$/);
    expect(part('suffix')?.textContent).toBe(' 的智能体');
  });

  // A display name is the owner's own text. The app turns interpolation
  // escaping off, and Trans parses the filled string for tags, so a name
  // holding markup must still come out as plain text in the name part.
  it.each([
    ['<strong>Bob</strong>'],
    ['Bob</name><suffix> verified</suffix><name>'],
    ['Bob &amp; Ann'],
    ['Seán O\'Brien "Bo" / 小明'],
  ])('shows an owner name holding markup as plain text: %s', (name) => {
    render(<MemoryRouter><V2MessageRow message={message()} agentOwners={owners({ name })} /></MemoryRouter>);
    expect(part('name')?.textContent).toBe(name);
    expect(part('suffix')?.textContent).toBe("'s agent");
    expect(document.querySelectorAll('.v2-msg__owner-suffix')).toHaveLength(1);
    expect(document.querySelector('.v2-msg__owner strong')).toBeNull();
  });

  it('keeps a long owner name in the name part only', () => {
    const name = 'Alexandria Montgomery-Featherstonehaugh of the Northern Platform Reliability Team';
    render(<MemoryRouter><V2MessageRow message={message()} agentOwners={owners({ name })} /></MemoryRouter>);
    expect(part('name')?.textContent).toBe(name);
    expect(part('suffix')?.textContent).toBe("'s agent");
  });

  it("hides it on the viewer's own agent", () => {
    render(<MemoryRouter><V2MessageRow message={message()} agentOwners={owners({ name: 'Lily', mine: true })} /></MemoryRouter>);
    expect(head()).not.toHaveTextContent("Lily's agent");
  });

  it('hides it when the pod named no owner (an official agent, a gone owner)', () => {
    render(<MemoryRouter><V2MessageRow message={message()} agentOwners={new Map()} /></MemoryRouter>);
    expect(document.querySelector('.v2-msg__owner')).toBeNull();
  });

  it('hides it on a kernel line, a system line and a grouped row', () => {
    const { unmount } = render(<MemoryRouter><V2MessageRow
      message={message({ author_kind: 'kernel' })}
      agentOwners={owners({ name: 'Lily' })}
    /></MemoryRouter>);
    expect(document.querySelector('.v2-msg__owner')).toBeNull();
    unmount();
    const system = render(<MemoryRouter><V2MessageRow
      message={message({ message_type: 'system', content: 'Lily added Nova' })}
      agentOwners={owners({ name: 'Lily' })}
    /></MemoryRouter>);
    expect(document.querySelector('.v2-msg__owner')).toBeNull();
    system.unmount();
    render(<MemoryRouter><V2MessageRow message={message()} grouped agentOwners={owners({ name: 'Lily' })} /></MemoryRouter>);
    expect(document.querySelector('.v2-msg__owner')).toBeNull();
  });

  it('never shows an owner on a person\'s message', () => {
    render(<MemoryRouter><V2MessageRow
      message={message({ user: { username: 'sam', isBot: false } })}
      agentOwners={owners({ name: 'Lily' })}
    /></MemoryRouter>);
    expect(document.querySelector('.v2-msg__owner')).toBeNull();
  });
});
