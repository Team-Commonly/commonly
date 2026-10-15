// @ts-nocheck
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2MessageRow, { CollapsiblePre, MessageMarkdownImage } from '../components/V2MessageRow';
import { messageImageUrl } from '../utils/messageImageUrl';
import { __resetSignedAttachmentUrlCacheForTests } from '../../utils/signedAttachmentUrl';

// The repository-wide markdown mock only returns text. Exercise the image
// component map in this suite so the row cannot bypass the origin guard.
jest.mock('react-markdown', () => {
  const ReactForMock = require('react');
  return {
    __esModule: true,
    default: ({ children, components }) => {
      const image = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(String(children));
      return image
        ? ReactForMock.createElement(components.img, { alt: image[1], src: image[2] })
        : ReactForMock.createElement('div', { 'data-testid': 'react-markdown' }, children);
    },
  };
});

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

  test('a foreign markdown image is a plain link and creates no image element', () => {
    const { container } = render(<MessageMarkdownImage src="https://outside.example/collect?secret=x" alt="report" />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('link', { name: 'report' })).toHaveAttribute('href', 'https://outside.example/collect?secret=x');
  });

  test('the v2 message row routes markdown images through the origin guard', () => {
    renderRow(message('![report](https://outside.example/collect.png)'));
    expect(document.querySelector('.v2-msg__content img')).toBeNull();
    expect(screen.getByRole('link', { name: 'report' })).toHaveAttribute('href', 'https://outside.example/collect.png');
  });

  test('an instance upload in markdown still renders as an image', () => {
    const { container } = render(<MessageMarkdownImage src="/api/uploads/report.png" alt="report" />);
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://api.commonly.me/api/uploads/report.png');
  });

  test('a signed upload response cannot switch the image to a foreign host', async () => {
    __resetSignedAttachmentUrlCacheForTests();
    localStorage.setItem('token', 'test-token');
    const previousFetch = global.fetch;
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ url: 'https://outside.example/collect.png?secret=x', expiresIn: 300 }),
    } as Response);
    global.fetch = fetchSpy;
    try {
      const { container } = render(<MessageMarkdownImage src="/api/uploads/signed-control.png" alt="report" />);
      await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
      await act(async () => { await fetchSpy.mock.results[0].value; });
      expect(container.querySelector('img')).toHaveAttribute('src', 'https://api.commonly.me/api/uploads/signed-control.png');
    } finally {
      global.fetch = previousFetch;
      localStorage.removeItem('token');
      __resetSignedAttachmentUrlCacheForTests();
    }
  });

  test('a foreign legacy image message cannot enter the gallery', () => {
    renderRow(message('https://outside.example/collect.png?secret=x', { message_type: 'image' }));
    expect(document.querySelector('.v2-msg__thumbs')).toBeNull();
    expect(screen.getByRole('link', { name: /outside\.example/ })).toBeInTheDocument();
  });

  test('image URL guard accepts only this instance upload origin and path', () => {
    expect(messageImageUrl('https://api.commonly.me/api/uploads/one.png')).toBe('https://api.commonly.me/api/uploads/one.png');
    expect(messageImageUrl('https://api.commonly.me.evil.test/api/uploads/one.png')).toBeNull();
    expect(messageImageUrl('https://outside.example/api/uploads/one.png')).toBeNull();
    expect(messageImageUrl('https://api.commonly.me/other/one.png')).toBeNull();
    expect(messageImageUrl('data:image/svg+xml,<svg/>')).toBeNull();
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
