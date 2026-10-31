import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '../../i18n';
import V2MessageRow, { CollapsibleProse } from '../components/V2MessageRow';

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { username: 'viewer' } }),
}));

const setScrollHeight = (px: number) => {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => px });
};

describe('CollapsibleProse', () => {
  afterEach(() => {
    setScrollHeight(0);
    return i18n.changeLanguage('en');
  });

  it('folds a long agent message past six lines behind a real Show more button', () => {
    setScrollHeight(900);
    const { container } = render(
      <CollapsibleProse collapsible>
        <div className="v2-msg__content">long reply</div>
      </CollapsibleProse>,
    );
    const wrapper = container.querySelector('.v2-msg__prose');
    expect(wrapper).toHaveClass('v2-msg__prose--closed');
    const button = screen.getByRole('button', { name: 'Show more' });
    expect(button).toHaveClass('v2-msg__showmore');
    expect(button).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(button);
    expect(wrapper).not.toHaveClass('v2-msg__prose--closed');
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('expands a folded message when focus reaches a link below the fold, and keeps the preview readable', () => {
    setScrollHeight(900);
    const { container } = render(
      <CollapsibleProse collapsible>
        <a className="v2-msg__content" href="https://example.com">long link</a>
      </CollapsibleProse>,
    );
    const wrapper = container.querySelector('.v2-msg__prose');
    expect(wrapper).toHaveClass('v2-msg__prose--closed');
    expect(wrapper).not.toHaveAttribute('inert');
    // The preview stays in the accessibility tree and is not hidden from assistive tech.
    const link = screen.getByRole('link', { name: 'long link' });
    const scrollIntoView = jest.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    // Defer the frame so the test can tell a scroll that waits for the expand from one that runs during focus.
    const frames: FrameRequestCallback[] = [];
    const raf = jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { frames.push(cb); return frames.length; });
    act(() => link.focus());
    expect(wrapper).not.toHaveClass('v2-msg__prose--closed');
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
    // Nothing scrolls during focus: the scroll waits for the open frame to paint.
    expect(scrollIntoView).not.toHaveBeenCalled();
    act(() => frames.forEach((cb) => cb(0)));
    // Once open, the focused link itself is scrolled into the visible scroller, not left clipped below it.
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(scrollIntoView.mock.instances[0]).toBe(link);
    raf.mockRestore();
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  });

  it('does not fold at 133px and folds at 134px', () => {
    setScrollHeight(133);
    const atLimit = render(
      <CollapsibleProse collapsible>
        <div className="v2-msg__content">at limit</div>
      </CollapsibleProse>,
    );
    expect(atLimit.container.querySelector('.v2-msg__prose--closed')).toBeNull();
    atLimit.unmount();

    setScrollHeight(134);
    const past = render(
      <CollapsibleProse collapsible>
        <div className="v2-msg__content">past limit</div>
      </CollapsibleProse>,
    );
    expect(past.container.querySelector('.v2-msg__prose--closed')).not.toBeNull();
  });

  it('renders a short agent message with no fold and no button', () => {
    setScrollHeight(120);
    const { container } = render(
      <CollapsibleProse collapsible>
        <div className="v2-msg__content">short reply</div>
      </CollapsibleProse>,
    );
    expect(container.querySelector('.v2-msg__prose--closed')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('leaves non-agent messages untouched even when they are long', () => {
    setScrollHeight(900);
    const { container } = render(
      <CollapsibleProse collapsible={false}>
        <div className="v2-msg__content">human reply</div>
      </CollapsibleProse>,
    );
    expect(container.querySelector('.v2-msg__prose')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('uses Chinese labels for the fold control', async () => {
    await i18n.changeLanguage('zh-CN');
    setScrollHeight(900);
    render(
      <CollapsibleProse collapsible>
        <div className="v2-msg__content">长回复</div>
      </CollapsibleProse>,
    );
    expect(screen.getByRole('button', { name: '展开' })).toBeInTheDocument();
  });

  describe('author gate on a row', () => {
    const longText = 'long reply '.repeat(80);
    const rowFor = (user: { username: string; isBot?: boolean }) => (
      <MemoryRouter>
        <V2MessageRow
          message={{ id: 'gate', pod_id: 'pod-1', user_id: 'u-1', message_type: 'text',
            content: longText, created_at: '2026-10-31T09:00:00.000Z', user }}
          agentTags={new Map([[user.username, 'claude']])}
        />
      </MemoryRouter>
    );

    it('folds a long reply from a confirmed bot author', () => {
      setScrollHeight(900);
      render(rowFor({ username: 'vale', isBot: true }));
      expect(screen.getByRole('button', { name: 'Show more' })).toBeInTheDocument();
    });

    it('does not fold a human whose username matches an agent tag', () => {
      setScrollHeight(900);
      render(rowFor({ username: 'vale', isBot: false }));
      expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    });

    it('does not fold when the author identity is unknown', () => {
      setScrollHeight(900);
      render(rowFor({ username: 'vale' }));
      expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    });
  });
});
