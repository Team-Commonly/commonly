// @ts-nocheck
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2MessageRow, { CollapsiblePre } from '../components/V2MessageRow';

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { username: 'viewer' } }),
}));
jest.mock('../hooks/useV2Api', () => ({
  useV2Api: () => ({ get: jest.fn(), post: jest.fn(), patch: jest.fn(), del: jest.fn() }),
}));

const message = (content, extra = {}) => ({
  id: '1',
  pod_id: 'pod-1',
  user_id: 'sender-1',
  content,
  created_at: '2026-09-06T09:04:00.000Z',
  user: { username: 'ux-lead' },
  ...extra,
});

const renderRow = (msg, props = {}) => render(
  <MemoryRouter><V2MessageRow message={msg} {...props} /></MemoryRouter>,
);

describe('V2MessageRow attachments (direction C)', () => {
  const previousApiUrl = process.env.REACT_APP_API_URL;
  beforeEach(() => { process.env.REACT_APP_API_URL = 'https://api.commonly.me'; });
  afterEach(() => { process.env.REACT_APP_API_URL = previousApiUrl; });

  test('uploaded images render as thumbnails in one gallery, and a click opens the lightbox that Esc closes', () => {
    renderRow(message('Walk at 1440 and 390, both states. [[upload:1-walk.png|walk-1440.png|412000|image]] [[upload:2-walk.png|walk-390.png|188000|image]]'));
    const thumbs = screen.getAllByRole('button', { name: /^Open walk-/ });
    expect(thumbs).toHaveLength(2);
    expect(thumbs[0].querySelector('img')).toHaveAttribute('src', 'https://api.commonly.me/api/uploads/1-walk.png');
    expect(thumbs[0].closest('.v2-msg__thumbs')).toBeTruthy();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(thumbs[1]);
    const dialog = screen.getByRole('dialog', { name: 'walk-390.png' });
    expect(dialog).toHaveTextContent('walk-390.png · 2/2');
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    expect(screen.getByRole('dialog')).toHaveTextContent('walk-1440.png · 1/2');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('non-image uploads render as chips with a text type badge, name and size — no colour square', () => {
    const onOpenFile = jest.fn();
    renderRow(message('PR 2 plan attached. [[upload:9-plan.pdf|channel-reply-resolution.pdf|319488|document]] [[upload:8-plan.md|plan.md|4096|document]]'), { onOpenFile });
    const chip = screen.getByRole('button', { name: 'Open channel-reply-resolution.pdf' });
    expect(chip).toHaveClass('v2-msg__chip');
    expect(chip.querySelector('.v2-msg__chip-ext')).toHaveTextContent('pdf');
    expect(chip.querySelector('.v2-msg__chip-ext')).not.toHaveAttribute('style');
    expect(chip.querySelector('.v2-msg__chip-size')).toHaveTextContent('312 KB');
    expect(document.querySelector('.v2-msg__file-icon')).toBeNull();
    fireEvent.click(chip);
    expect(onOpenFile).toHaveBeenCalledWith('9-plan.pdf');
    expect(screen.queryByRole('button', { name: /^Open .*\.png/ })).not.toBeInTheDocument();
  });

  test('a directive quoted in backticks or a fence stays text — no chip, no thumbnail', () => {
    renderRow(message('The grammar is `[[upload:abc.png|abc.png|12|image]]` and fenced:\n```\n[[upload:def.md|def.md|3|document]]\n```'));
    expect(document.querySelector('.v2-msg__thumb')).toBeNull();
    expect(document.querySelector('.v2-msg__chip')).toBeNull();
    expect(document.querySelector('.v2-msg__content')).toHaveTextContent('[[upload:abc.png|abc.png|12|image]]');
  });

  test('a legacy image message becomes one thumbnail, not a bare link', () => {
    renderRow(message('/api/uploads/avatar.png', { message_type: 'image' }));
    const thumb = screen.getByRole('button', { name: 'Open image' });
    expect(thumb.querySelector('img')).toHaveAttribute('src', 'https://api.commonly.me/api/uploads/avatar.png');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  // react-markdown is mocked in jsdom, so the collapse is tested at the
  // component the markdown `pre` override renders.
  test('fenced code past six lines collapses with Show N more lines and expands in place', () => {
    const code = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');
    render(<CollapsiblePre><code>{`${code}\n`}</code></CollapsiblePre>);
    const more = screen.getByRole('button', { name: 'Show 6 more lines' });
    expect(more.closest('.v2-msg__collapse')).toHaveClass('v2-msg__collapse--closed');
    fireEvent.click(more);
    expect(screen.getByRole('button', { name: 'Show less' }).closest('.v2-msg__collapse')).toHaveClass('v2-msg__collapse--open');
  });

  test('short code does not collapse', () => {
    const { container } = render(<CollapsiblePre><code>{'one\ntwo\nthree\n'}</code></CollapsiblePre>);
    expect(screen.queryByRole('button', { name: /Show/ })).not.toBeInTheDocument();
    expect(container.querySelector('.v2-msg__collapse')).toBeNull();
    expect(container.querySelector('pre')).toBeTruthy();
  });
});
