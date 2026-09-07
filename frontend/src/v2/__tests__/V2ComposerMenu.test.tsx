// @ts-nocheck
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import i18n, { i18nReady } from '../../i18n';
import V2Composer from '../components/V2Composer';

const renderComposer = (overrides = {}) => {
  const props = {
    podName: 'Sharpen',
    authorName: 'lily',
    draft: '',
    sending: false,
    uploading: false,
    replyTarget: null,
    threadTarget: null,
    mentionOpen: false,
    mentionIndex: 0,
    mentions: [],
    warnings: [],
    inputRef: React.createRef(),
    fileInputRef: React.createRef(),
    mentionDropdownRef: React.createRef(),
    onDraftChange: jest.fn(),
    onDraftPointer: jest.fn(),
    onKeyDown: jest.fn(),
    onMentionSelect: jest.fn(),
    onSend: jest.fn(),
    onAttach: jest.fn(),
    onPasteFromClipboard: jest.fn(),
    onCancelReply: jest.fn(),
    onCancelThread: jest.fn(),
    ...overrides,
  };
  const view = render(<V2Composer {...props} />);
  return { props, ...view };
};

describe('V2Composer (direction C)', () => {
  beforeAll(async () => { await i18nReady; await act(async () => { await i18n.changeLanguage('en'); }); });

  test('one row: a 24px plus, a one-line field, no identity line, and no Send until there is text', () => {
    const { container } = renderComposer();
    expect(container.querySelector('.v2-composer__row')).toBeTruthy();
    expect(screen.getByRole('textbox')).toHaveAttribute('rows', '1');
    expect(screen.queryByText(/posts as/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send message' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toHaveAttribute('aria-haspopup', 'menu');
  });

  test('Send appears with text, carries the identity and shortcut in its tooltip, and sends', () => {
    const { props } = renderComposer({ draft: '@sprint-impl press #1573 when green' });
    const send = screen.getByRole('button', { name: 'Send message' });
    expect(send).toHaveAttribute('title', 'Send as lily · Enter');
    fireEvent.click(send);
    expect(props.onSend).toHaveBeenCalledTimes(1);
  });

  test('the plus opens a three-row menu; attach file and attach image set the accept before opening the picker; paste reads the clipboard', () => {
    jest.useFakeTimers();
    const { props, container } = renderComposer();
    const clickSpy = jest.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    const items = screen.getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Attach file', 'Attach image', 'Paste image from clipboard']);

    fireEvent.click(items[1]);
    act(() => { jest.runAllTimers(); });
    expect(container.querySelector('input[type=file]')).toHaveAttribute('accept', 'image/*');
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getAllByRole('menuitem')[0]);
    act(() => { jest.runAllTimers(); });
    expect(container.querySelector('input[type=file]').getAttribute('accept')).toContain('.pdf');

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getAllByRole('menuitem')[2]);
    expect(props.onPasteFromClipboard).toHaveBeenCalledTimes(1);
    clickSpy.mockRestore();
    jest.useRealTimers();
  });

  test('a thread target is an inline tag inside the row with its own cancel', () => {
    const { props } = renderComposer({ threadTarget: { id: '7', preview: 'Replacement is #1569' } });
    const tag = screen.getByRole('status');
    expect(tag).toHaveClass('v2-composer__aim');
    expect(tag).toHaveTextContent('↳ replying in thread');
    expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', 'Reply in thread');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel reply' }));
    expect(props.onCancelThread).toHaveBeenCalledTimes(1);
  });

  test('aiming at a person reads ↳ replying to <author> and the placeholder follows', () => {
    renderComposer({ replyTarget: { id: '3', content: 'hi', user: { username: 'vera' } } });
    expect(screen.getByRole('status')).toHaveTextContent('↳ replying to vera');
    expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', 'Reply to vera');
  });

  test('uploading shows a mono status beside the field', () => {
    renderComposer({ uploading: true });
    expect(screen.getByRole('status')).toHaveTextContent('Uploading…');
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
  });
});
