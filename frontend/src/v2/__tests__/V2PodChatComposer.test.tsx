// @ts-nocheck
// Regression for the send-button click: handleSend(override?: string) was
// wired as onClick={handleSend}, so the MouseEvent arrived as `override` and
// (override ?? draft).trim() threw — the button silently did nothing while
// Enter-to-send kept working (regressed in 45380a50).
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2PodChat from '../components/V2PodChat';
import { AuthContext } from '../../context/AuthContext';

jest.mock('../../context/SocketContext', () => ({
  useSocket: () => ({ socket: null, connected: false }),
}));

// Composer behavior does not depend on avatar rendering. Keep this test
// isolated from the external DiceBear package graph used by V2Avatar.
jest.mock('../components/V2Avatar', () => () => <span data-testid="avatar" />);
jest.mock('../utils/avatars', () => ({ initialsFor: (name: string) => name.slice(0, 2) }));

// jsdom has no scrollIntoView; the component auto-scrolls on mount.
beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
});

// Same mock surface as V2Login.test.tsx — axiosConfig assigns
// axios.defaults.baseURL at import time.
jest.mock('axios', () => {
  const mock = {
    get: jest.fn(() => Promise.resolve({ data: {} })),
    post: jest.fn(() => Promise.resolve({ data: {} })),
    patch: jest.fn(),
    delete: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() },
    },
  };
  return { __esModule: true, default: mock, ...mock };
});

const authValue = {
  currentUser: { _id: 'u1', username: 'solo-user' },
  user: { _id: 'u1', username: 'solo-user' },
  token: 't',
  loading: false,
  error: null,
  isAuthenticated: true,
  register: jest.fn(),
  login: jest.fn(),
  logout: jest.fn(),
  updateProfile: jest.fn(),
};

const makeDetail = (overrides = {}) => ({
  pod: { _id: 'p1', name: 'My Workspace', type: 'chat' },
  members: [{ _id: 'u1', username: 'solo-user', isBot: false }],
  messages: [],
  agents: [],
  sendMessage: jest.fn(() => Promise.resolve({ _id: 'm1' })),
  loading: false,
  error: null,
  sendError: null,
  refresh: jest.fn(),
  ...overrides,
});

const renderChat = (detail) => render(
  <AuthContext.Provider value={authValue}>
    <MemoryRouter>
      <V2PodChat detail={detail} />
    </MemoryRouter>
  </AuthContext.Provider>,
);

describe('V2PodChat composer send button', () => {
  test('clicking the send button sends the drafted text', async () => {
    const detail = makeDetail();
    renderChat(detail);

    fireEvent.change(screen.getByPlaceholderText(/message my workspace/i), {
      target: { value: 'hello team' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));

    await waitFor(() => {
      // 4th arg is threadRootId (W-T 4/4). Both trailing args are undefined
      // for an ordinary send, and that IS the assertion: a plain message must
      // carry neither an addressing edge nor a thread membership.
      expect(detail.sendMessage).toHaveBeenCalledWith('hello team', 'text', undefined, undefined);
    });
  });

  test('send button is disabled while the draft is empty', () => {
    renderChat(makeDetail());
    expect(screen.getByRole('button', { name: /send message/i })).toBeDisabled();
  });

  test('shows send failures by the composer and keeps the reply draft intact', async () => {
    const detail = makeDetail({
      messages: [{
        id: 'm1',
        pod_id: 'p1',
        user_id: 'u2',
        content: 'Can you check this?',
        message_type: 'text',
        created_at: '2026-08-22T13:00:00Z',
        user: { username: 'teammate' },
      }],
      sendMessage: jest.fn(() => Promise.resolve(null)),
    });
    const { rerender } = renderChat(detail);

    fireEvent.click(screen.getByRole('button', { name: /reply to teammate/i }));
    fireEvent.change(screen.getByPlaceholderText(/message my workspace/i), {
      target: { value: 'I am checking it now.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));
    await waitFor(() => {
      // Reply-to-person sets the addressing edge and NOT the thread root.
      // Exclusive at the composer for a semantic reason — an in-thread post
      // must not ping the root author — and NOT because the backend refuses
      // the pair; it only refuses a pair that disagrees.
      expect(detail.sendMessage).toHaveBeenCalledWith('I am checking it now.', 'text', 'm1', undefined);
    });

    rerender(
      <AuthContext.Provider value={authValue}>
        <MemoryRouter>
          <V2PodChat detail={{ ...detail, sendError: 'Replies are temporarily unavailable. Please try again shortly.' }} />
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    const sendError = screen.getByText('Replies are temporarily unavailable. Please try again shortly.');
    expect(sendError.closest('.v2-chat__composer')).not.toBeNull();
    expect(sendError.closest('.v2-chat__messages')).toBeNull();
    expect(screen.getByPlaceholderText(/message my workspace/i)).toHaveValue('I am checking it now.');
    expect(screen.getByRole('button', { name: /cancel reply/i }).closest('.v2-chat__reply-chip')).not.toBeNull();
  });

  // W-T 4/4, constraint 4 (docs/design/threading-surface-ruling.md; ux-lead
  // 57449): the composer has ONE target with two kinds. "Reply in thread"
  // sends threadRootId and NO reply edge; "Reply to <person>" sends the reply
  // edge and NO thread root; aiming at one clears the other.
  //
  // These pin it CLIENT-SIDE because nothing else does: the resolver rejects
  // the pair only when the two disagree, so a message carrying both that
  // happen to agree sails through and silently pings the root author.
  const threadMessages = () => ([
    {
      id: 'm1',
      pod_id: 'p1',
      user_id: 'u2',
      content: 'Root of the thread',
      message_type: 'text',
      created_at: '2026-08-22T13:00:00Z',
      user: { username: 'teammate' },
    },
    {
      id: 'm2',
      pod_id: 'p1',
      user_id: 'u3',
      thread_root_id: 'm1',
      content: 'First reply in the thread',
      message_type: 'text',
      created_at: '2026-08-22T13:05:00Z',
      user: { username: 'other' },
    },
  ]);

  const replyFromExpandedThread = () => screen.getByRole('button', { name: /reply from expanded thread/i });

  test('"Reply in thread" from the expanded rail sends threadRootId and no reply edge', async () => {
    const detail = makeDetail({ messages: threadMessages() });
    renderChat(detail);

    fireEvent.click(replyFromExpandedThread());
    expect(screen.getByText(/replying in thread/i)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/message my workspace/i), {
      target: { value: 'Joining the thread.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));
    await waitFor(() => {
      expect(detail.sendMessage).toHaveBeenCalledWith('Joining the thread.', 'text', undefined, 'm1');
    });
  });

  test('aiming at a thread clears a prior reply target, and vice versa', async () => {
    const detail = makeDetail({ messages: threadMessages() });
    renderChat(detail);

    // Reply-to-person first, then "Reply in thread": the thread wins, the
    // reply edge is gone.
    fireEvent.click(screen.getByRole('button', { name: /reply to other/i }));
    fireEvent.click(replyFromExpandedThread());
    fireEvent.change(screen.getByPlaceholderText(/message my workspace/i), {
      target: { value: 'thread wins' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));
    await waitFor(() => {
      expect(detail.sendMessage).toHaveBeenLastCalledWith('thread wins', 'text', undefined, 'm1');
    });

    // The other order: thread first, then reply-to-person. The reply edge
    // wins, the thread root is gone.
    fireEvent.click(replyFromExpandedThread());
    fireEvent.click(screen.getByRole('button', { name: /reply to other/i }));
    fireEvent.change(screen.getByPlaceholderText(/message my workspace/i), {
      target: { value: 'reply wins' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));
    await waitFor(() => {
      expect(detail.sendMessage).toHaveBeenLastCalledWith('reply wins', 'text', 'm2', undefined);
    });
  });

  test('an image upload carries the thread target too', async () => {
    // The regression @sprint-review caught on #1150: the TEXT path passed the
    // thread root and the image path did not, so uploading a picture while
    // the composer read "Replying in thread" posted it to the channel. Two
    // send sites, one of them updated — the classic shape, and there was no
    // test on this path at all, which is why it was missed.
    const axios = require('axios');
    axios.post.mockImplementation((url: string) => (
      String(url).includes('/api/uploads')
        ? Promise.resolve({ data: { kind: 'image', url: 'https://cdn/x.png' } })
        : Promise.resolve({ data: {} })
    ));

    const detail = makeDetail({ messages: threadMessages() });
    const { container } = renderChat(detail);

    fireEvent.click(replyFromExpandedThread());

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'x.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(detail.sendMessage).toHaveBeenCalledWith(
        'https://cdn/x.png', 'image', undefined, 'm1',
      );
    });
  });

  // ── TASK-049 items 1 and 4: the image path is a second send site ──────────
  const mockUpload = () => {
    const axios = require('axios');
    axios.post.mockImplementation((url: string) => (
      String(url).includes('/api/uploads')
        ? Promise.resolve({ data: { kind: 'image', url: 'https://cdn/x.png' } })
        : Promise.resolve({ data: {} })
    ));
  };
  const upload = (container: HTMLElement) => {
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'x.png', { type: 'image/png' })] } });
  };

  test('an image upload carries the REPLY edge when aimed at a person', async () => {
    // @ux-lead 57473. #1150 wired the thread root on this line and left the
    // reply edge hardcoded undefined, so the chip read "Replying to {name}"
    // and the picture posted unrouted. The other half of the same line.
    mockUpload();
    const detail = makeDetail({ messages: threadMessages() });
    const { container } = renderChat(detail);

    fireEvent.click(screen.getByRole('button', { name: /reply to other/i }));
    upload(container);

    await waitFor(() => {
      expect(detail.sendMessage).toHaveBeenCalledWith(
        'https://cdn/x.png', 'image', 'm2', undefined,
      );
    });
  });

  test('a successful image send consumes the target, so it cannot leak to the next send', async () => {
    // The ruling says a send consumes the target on EVERY path. The image path
    // did not, so an aim survived a completed send and silently applied again.
    mockUpload();
    const detail = makeDetail({ messages: threadMessages() });
    const { container } = renderChat(detail);

    fireEvent.click(replyFromExpandedThread());
    upload(container);
    await waitFor(() => expect(detail.sendMessage).toHaveBeenCalledTimes(1));

    // The chip is gone, and a following text send carries no target at all.
    await waitFor(() => {
      expect(screen.queryByText(/replying in thread/i)).not.toBeInTheDocument();
    });
    fireEvent.change(screen.getByPlaceholderText(/message my workspace/i), {
      target: { value: 'unaimed' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));
    await waitFor(() => {
      expect(detail.sendMessage).toHaveBeenLastCalledWith('unaimed', 'text', undefined, undefined);
    });
  });

  test('Thread from a message without replies starts a thread without replying to its author', async () => {
    const detail = makeDetail({ messages: [threadMessages()[0]] });
    renderChat(detail);

    fireEvent.click(screen.getByRole('button', { name: /thread from teammate/i }));
    expect(screen.getByText(/replying in thread/i)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/message my workspace/i), {
      target: { value: 'Starting a thread.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));

    await waitFor(() => {
      expect(detail.sendMessage).toHaveBeenCalledWith('Starting a thread.', 'text', undefined, 'm1');
    });
  });

  test('Thread from a reply keeps its existing root instead of asking the server to nest it', async () => {
    const detail = makeDetail({ messages: threadMessages() });
    renderChat(detail);

    fireEvent.click(screen.getByRole('button', { name: /thread from other/i }));
    fireEvent.change(screen.getByPlaceholderText(/message my workspace/i), {
      target: { value: 'Still in the first thread.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));

    await waitFor(() => {
      expect(detail.sendMessage).toHaveBeenCalledWith('Still in the first thread.', 'text', undefined, 'm1');
    });
  });

  test('the headline card aims the same root without requiring an expand', async () => {
    const detail = makeDetail({ messages: threadMessages() });
    renderChat(detail);

    fireEvent.click(screen.getByRole('button', { name: /^reply in thread$/i }));
    fireEvent.change(screen.getByPlaceholderText(/message my workspace/i), {
      target: { value: 'Joining through the card.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));

    await waitFor(() => {
      expect(detail.sendMessage).toHaveBeenCalledWith('Joining through the card.', 'text', undefined, 'm1');
    });
  });

  test('Reply still sends only the reply edge', async () => {
    const detail = makeDetail({ messages: threadMessages() });
    renderChat(detail);

    fireEvent.click(screen.getByRole('button', { name: /reply to other/i }));
    fireEvent.change(screen.getByPlaceholderText(/message my workspace/i), {
      target: { value: 'Replying to a person.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));

    await waitFor(() => {
      expect(detail.sendMessage).toHaveBeenCalledWith('Replying to a person.', 'text', 'm2', undefined);
    });
  });
});
