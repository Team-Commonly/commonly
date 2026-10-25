import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '../../i18n';
import V2MessageRow from '../components/V2MessageRow';

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { username: 'viewer' } }),
}));

describe('V2MessageRow', () => {
  const previousApiUrl = process.env.REACT_APP_API_URL;

  afterEach(() => {
    process.env.REACT_APP_API_URL = previousApiUrl;
    return i18n.changeLanguage('en');
  });

  it('shows a sender-only non-member notice as a quiet system line', () => {
    render(
      <MemoryRouter>
        <V2MessageRow message={{
          id: 'unreachable-mention', pod_id: 'pod-1', user_id: 'viewer-1',
          message_type: 'text', content: 'Please review @rhea',
          created_at: '2026-10-23T21:00:00.000Z', user: { username: 'viewer' },
          mentionNotices: [{ code: 'MENTION_NOT_IN_POD', handle: 'rhea', message: "rhea isn't in this pod. Invite them, or ask in a pod they're in." }],
        }} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('status')).toHaveClass('v2-msg__sender-notice');
    expect(screen.getByRole('status')).toHaveTextContent("rhea isn't in this pod");
  });

  it('uses Chinese UI copy instead of the English MCP sentence', async () => {
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    render(
      <MemoryRouter>
        <V2MessageRow message={{
          id: 'zh-mention', pod_id: 'pod-1', user_id: 'viewer-1',
          message_type: 'text', content: '@rhea',
          created_at: '2026-10-23T21:00:00.000Z', user: { username: 'viewer' },
          mentionNotices: [{ code: 'MENTION_NOT_IN_POD', handle: 'rhea', message: 'English MCP text' }],
        }} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('rhea 不在这个 Pod 中');
    expect(screen.getByRole('status')).not.toHaveTextContent('English MCP text');
  });

  it('links the sender to a visible pod where the mentioned agent is installed', () => {
    render(<MemoryRouter><V2MessageRow message={{
      id: 'mention-location', pod_id: 'pod-1', user_id: 'viewer-1', message_type: 'text',
      content: '@rhea review', created_at: '2026-10-24T10:00:00.000Z', user: { username: 'viewer' },
      mentionNotices: [{ code: 'MENTION_NOT_IN_POD', handle: 'rhea', message: 'API feedback',
        pods: [{ id: 'reviews-pod', name: 'Reviews' }] }],
    }} /></MemoryRouter>);
    expect(screen.getByRole('status')).toHaveTextContent("rhea isn't in this pod. Ask in:");
    expect(screen.getByRole('link', { name: 'Reviews' })).toHaveAttribute('href', '/v2/pods/chat/reviews-pod');
  });

  it('keeps the runtime beside the agent name before its timestamp', () => {
    render(
      <MemoryRouter>
        <V2MessageRow
          message={{ id: 'runtime-label', pod_id: 'pod-1', user_id: 'vale-1',
            message_type: 'text', content: 'Review complete.',
            created_at: '2026-09-08T20:00:00.000Z',
            user: { username: 'vale', isBot: true } }}
          agentTags={new Map([['vale', 'claude']])}
          agentDisplayNames={new Map([['vale', 'Vale']])}
        />
      </MemoryRouter>,
    );
    const tag = screen.getByText('claude');
    expect(tag.previousElementSibling).toHaveTextContent('Vale');
    expect(tag.nextElementSibling).toHaveClass('v2-msg__time');
  });

  // TASK-374. The auto-linkify match used to stop at the first dot, so
  // github.com/x linked only "https://github". The markdown renderer is mocked
  // in this suite and echoes its source, so each case checks the markdown the
  // row produced for the body.
  const markdownFor = (content) => {
    const { container, unmount } = render(
      <MemoryRouter>
        <V2MessageRow
          message={{ id: 'link-case', pod_id: 'pod-1', user_id: 'sender-1',
            content, message_type: 'text', created_at: '2026-10-23T00:00:00.000Z',
            user: { username: 'sender' } }}
        />
      </MemoryRouter>,
    );
    const text = container.querySelector('[data-testid="react-markdown"]').textContent;
    unmount();
    return text;
  };

  it('a PR URL whose card loads shows the card, and the URL is not repeated as text', async () => {
    const previousFetch = global.fetch;
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ title: 'Card loads', state: 'open', merged: false, number: 374101, html_url: 'https://github.com/Team-Commonly/commonly/pull/374101', commits: 1, additions: 1, deletions: 0, changed_files: 1 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => [] });
    try {
      const { container } = render(
        <MemoryRouter>
          <V2MessageRow
            message={{ id: 'pr-ok', pod_id: 'pod-1', user_id: 'sender-1',
              content: 'opened https://github.com/Team-Commonly/commonly/pull/374101 today',
              message_type: 'text', created_at: '2026-10-23T00:00:00.000Z', user: { username: 'sender' } }}
          />
        </MemoryRouter>,
      );
      expect(await screen.findByRole('link', { name: 'Pull request #374101: Card loads' })).toBeInTheDocument();
      const text = container.querySelector('[data-testid="react-markdown"]').textContent;
      // TASK-382: the sentence keeps a short ref (anchor asserted in realMarkdown); the card is the only anchor here.
      expect(text).toContain('[Team-Commonly/commonly#374101](https://github.com/Team-Commonly/commonly/pull/374101)');
      expect(container.querySelectorAll('a[href*="pull/374101"]')).toHaveLength(1);
    } finally {
      global.fetch = previousFetch;
    }
  });

  it('a PR URL whose card fails keeps one full link, not zero and not two', async () => {
    const previousFetch = global.fetch;
    global.fetch = jest.fn().mockRejectedValue(new Error('private repo'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { container } = render(
        <MemoryRouter>
          <V2MessageRow
            message={{ id: 'pr-fail', pod_id: 'pod-1', user_id: 'sender-1',
              content: 'opened https://github.com/Team-Commonly/commonly/pull/374102 today',
              message_type: 'text', created_at: '2026-10-23T00:00:00.000Z', user: { username: 'sender' } }}
          />
        </MemoryRouter>,
      );
      const links = await screen.findAllByRole('link', { name: 'https://github.com/Team-Commonly/commonly/pull/374102' });
      expect(links).toHaveLength(1);
      expect(links[0]).toHaveAttribute('href', 'https://github.com/Team-Commonly/commonly/pull/374102');
      expect(container.querySelectorAll('a[href*="pull/374102"]')).toHaveLength(1);
    } finally {
      warn.mockRestore();
      global.fetch = previousFetch;
    }
  });

  it('links a repo URL as one full link, not just the first dot', () => {
    expect(markdownFor('see https://github.com/Team-Commonly/commonly for the code'))
      .toBe('see [https://github.com/Team-Commonly/commonly](https://github.com/Team-Commonly/commonly) for the code');
  });

  it('links a URL followed by a full stop without taking the stop', () => {
    expect(markdownFor('ship it at https://example.com/docs/page.'))
      .toBe('ship it at [https://example.com/docs/page](https://example.com/docs/page).');
  });

  it('links a URL in parentheses without taking the closing paren', () => {
    expect(markdownFor('(read https://example.com/guide)'))
      .toBe('(read [https://example.com/guide](https://example.com/guide))');
  });

  it('keeps a URL with its own balanced paren whole, encoding the parens in the destination', () => {
    expect(markdownFor('see https://en.wikipedia.org/wiki/Foo_(bar) now'))
      .toBe('see [https://en.wikipedia.org/wiki/Foo_(bar)](https://en.wikipedia.org/wiki/Foo_%28bar%29) now');
  });

  it('a closing bracket inside the URL stays in the link, escaped, and does not end the link early', () => {
    expect(markdownFor('see https://example.com/a]b now'))
      .toBe('see [https://example.com/a\\]b](https://example.com/a%5Db) now');
  });

  it('a paren after trailing punctuation is stripped in the right order', () => {
    expect(markdownFor('(see https://example.com/guide.)'))
      .toBe('(see [https://example.com/guide](https://example.com/guide).)');
  });

  it('leaves a markdown link untouched', () => {
    expect(markdownFor('[docs](https://example.com/docs) here'))
      .toBe('[docs](https://example.com/docs) here');
  });

  it('marks a Commonly-authored seat post without marking an agent post', () => {
    const { rerender } = render(
      <MemoryRouter>
        <V2MessageRow
          message={{ id: 'kernel-1', pod_id: 'pod-1', user_id: 'seat-1',
            message_type: 'text', content: 'Your agent is ready.',
            author_kind: 'kernel', created_at: '2026-09-08T20:00:00.000Z',
            user: { username: 'vale', isBot: true } }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByLabelText('Commonly system message')).toHaveTextContent('Commonly');

    rerender(
      <MemoryRouter>
        <V2MessageRow
          message={{ id: 'agent-1', pod_id: 'pod-1', user_id: 'seat-1',
            message_type: 'text', content: 'I am ready.',
            author_kind: null, created_at: '2026-09-08T20:00:00.000Z',
            user: { username: 'vale', isBot: true } }}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByLabelText('Commonly system message')).not.toBeInTheDocument();
  });

  it('resolves relative uploaded images against the configured API origin', () => {
    process.env.REACT_APP_API_URL = 'https://api.commonly.me';

    render(
      <MemoryRouter>
        <V2MessageRow
          message={{
            id: '1',
            pod_id: 'pod-1',
            user_id: 'sender-1',
            content: '/api/uploads/avatar.png',
            message_type: 'image',
            created_at: '2026-08-04T00:00:00.000Z',
            user: { username: 'sender' },
          }}
        />
      </MemoryRouter>,
    );

    // Direction C: the image is a thumbnail that opens the lightbox, not a link.
    expect(screen.getByRole('img', { name: 'image' })).toHaveAttribute(
      'src',
      'https://api.commonly.me/api/uploads/avatar.png',
    );
    expect(screen.getByRole('button', { name: 'Open image' })).toHaveClass('v2-msg__thumb');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  // A message with no reactions renders NO reactions row at all — the
  // trigger lives in the hover action cluster (2026-08-23), so the 2026-08-13
  // phantom-band bug cannot recur structurally. The trigger must still be
  // reachable, just from the cluster.
  it('renders no reactions row when a message has no reactions — the trigger lives in the cluster', () => {
    render(
      <MemoryRouter>
        <V2MessageRow
          message={{
            id: '42',
            pod_id: 'pod-1',
            user_id: 'sender-1',
            content: 'hello',
            message_type: 'text',
            created_at: '2026-08-13T00:00:00.000Z',
            user: { username: 'sender' },
            reactions: [],
          }}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByLabelText('Reactions')).toBeNull();
    // Reachability is preserved: the cluster carries the trigger.
    expect(screen.getByRole('button', { name: 'Add reaction' })).toBeInTheDocument();
  });

  it('keeps the reactions row in flow when chips exist', () => {
    render(
      <MemoryRouter>
        <V2MessageRow
          message={{
            id: '43',
            pod_id: 'pod-1',
            user_id: 'sender-1',
            content: 'hello',
            message_type: 'text',
            created_at: '2026-08-13T00:00:00.000Z',
            user: { username: 'sender' },
            reactions: [{ emoji: '👍', count: 2, mine: false }],
          }}
        />
      </MemoryRouter>,
    );

    const row = screen.getByLabelText('Reactions');
    expect(row.className).not.toContain('v2-msg__reactions--bare');
    expect(screen.getByText('👍')).toBeInTheDocument();
  });

  it('marks a system card with its action state', () => {
    render(
      <MemoryRouter>
        <V2MessageRow
          message={{
            id: '44',
            pod_id: 'pod-1',
            user_id: 'system-1',
            content: '🤝 Pixel and codex started a DM — [view](/v2/pods/0123456789abcdef01234567)',
            message_type: 'text',
            created_at: '2026-08-13T00:00:00.000Z',
            user: { username: 'commonly-bot' },
          }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('Pixel and codex started a DM').closest('.v2-syscard')).toHaveClass('v2-syscard--action');
  });

  it('renders a structured task claim as a quiet line without message actions', () => {
    render(
      <MemoryRouter>
        <V2MessageRow message={{
          id: '45', pod_id: 'pod-1', user_id: 'agent-1',
          content: 'Forge claimed TASK-406', message_type: 'system',
          created_at: '2026-10-23T20:00:00.000Z',
          payload: { kind: 'system-action', action: 'task-claimed', actorName: 'Forge', taskId: 'TASK-406' },
          user: { username: 'forge-agent', isBot: true },
        }} />
      </MemoryRouter>,
    );
    const line = screen.getByText('Forge').closest('.v2-system-action-line');
    expect(line).toBeInTheDocument();
    expect(line).toHaveTextContent('ForgeclaimedTASK-406');
    expect(line?.querySelector('.v2-system-action-line__object')).toHaveTextContent('TASK-406');
    expect(line?.querySelector('.v2-avatar')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

it('server-bound origin pod links a plain message after its content', () => {
  const runPodId = 'aaaaaaaaaaaaaaaaaaaaaaa1';
  const runId = 'bbbbbbbbbbbbbbbbbbbbbbb1';
  render(<MemoryRouter><V2MessageRow message={{ id: 'origin-run', pod_id: 'ccccccccccccccccccccccc1',
    user_id: 'agent-1', message_type: 'text', content: 'Approval requested.', created_at: '2026-10-25T00:00:00Z',
    user: { username: 'lark', isBot: true }, payload: { runId, runPodId },
  }} /></MemoryRouter>);
  const link = screen.getByRole('link', { name: 'View run trace' });
  expect(link).toHaveAttribute('href', `/v2/pods/${runPodId}/runs/${runId}`);
  const content = link.closest('.v2-msg__body').querySelector('.v2-msg__content');
  expect(content.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('the approval-card branch links to its server-bound original pod', () => {
  const runPodId = 'aaaaaaaaaaaaaaaaaaaaaaa1', runId = 'bbbbbbbbbbbbbbbbbbbbbbb1';
  render(<MemoryRouter><V2MessageRow message={{ id: 'approval-origin-run', pod_id: 'ccccccccccccccccccccccc1',
    user_id: 'agent-1', message_type: 'card', content: 'Approve the research pod', created_at: '2026-10-25T00:00:00Z',
    user: { username: 'lark', isBot: true }, payload: { kind: 'approval-card', runId, runPodId,
      approvalId: 'approval-1', actionType: 'create_pod', params: { name: 'Research' },
      summary: 'Approve the research pod', status: 'resolved', decision: 'declined', ownerUserId: 'owner-1',
    },
  }} /></MemoryRouter>);
  expect(screen.getByTestId('approval-card')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'View run trace' })).toHaveAttribute('href', `/v2/pods/${runPodId}/runs/${runId}`);
});
