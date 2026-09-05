import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import V2Composer from '../components/V2Composer';

const renderComposer = (overrides: Partial<React.ComponentProps<typeof V2Composer>> = {}) => {
  const props: React.ComponentProps<typeof V2Composer> = {
    podName: 'Sharpen',
    authorName: 'lily',
    draft: '',
    sending: false,
    uploading: false,
    sendError: null,
    composerError: null,
    replyTarget: null,
    threadTarget: null,
    mentionOpen: false,
    mentionIndex: 0,
    mentions: [],
    warnings: [],
    inputRef: { current: null },
    fileInputRef: { current: null },
    mentionDropdownRef: { current: null },
    onDraftChange: jest.fn(),
    onDraftPointer: jest.fn(),
    onKeyDown: jest.fn(),
    onMentionSelect: jest.fn(),
    onSend: jest.fn(),
    onAttach: jest.fn(),
    onCancelReply: jest.fn(),
    onCancelThread: jest.fn(),
    ...overrides,
  };
  return { props, ...render(<V2Composer {...props} />) };
};

describe('V2Composer', () => {
  test('keeps the workspace’s single bordered input and posts-as line independent of the thread controller', () => {
    const { props, container } = renderComposer({ draft: 'Ready to ship' });

    expect(container.querySelector('.v2-composer')).toBeInTheDocument();
    expect(screen.getByText('posts as lily · ⌘↵')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send message' })).toHaveTextContent('Send');

    fireEvent.change(screen.getByPlaceholderText('Message Sharpen…'), {
      target: { value: 'Next draft', selectionStart: 10 },
    });
    expect(props.onDraftChange).toHaveBeenCalledWith('Next draft', 10);

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(props.onSend).toHaveBeenCalledTimes(1);
  });
});
