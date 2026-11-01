// @ts-nocheck
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import V2AgentMemory, { groupSections, journalDay, latestDay } from '../agents/V2AgentMemory';

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
  };
  return { __esModule: true, default: mock, ...mock };
});
const axios = jest.requireMock('axios').default;

const section = (key, notes = 1) => ({
  key, label: key, kind: 'x', notes: Array.from({ length: notes }, (_, i) => ({ header: `${key} ${i}`, snippet: '' })),
});
const named = (key, headers) => ({
  key, label: key, kind: 'doc', notes: headers.map((h) => ({ header: h, snippet: '' })),
});
const renderPage = () => render(
  <MemoryRouter initialEntries={['/v2/agents/maya-claude/default/memory']}>
    <Routes>
      <Route path="/v2/agents/:agentName/:instanceId/memory" element={<V2AgentMemory />} />
    </Routes>
  </MemoryRouter>,
);
const headersOf = (groups, id) => groups.find((g) => g.id === id).sections.flatMap((s) => s.notes.map((n) => n.header));

describe('groupSections', () => {
  it('gives soul its own Identity group, shared its own Shared group, and journal sections to Journal', () => {
    const groups = groupSections([section('daily'), section('soul'), section('cycles'), section('shared')]);
    expect(groups.map((g) => g.id)).toEqual(['rules', 'how', 'journal', 'identity', 'shared']);
    expect(headersOf(groups, 'rules')).toEqual([]);
    expect(headersOf(groups, 'identity')).toEqual(['soul 0']);
    expect(headersOf(groups, 'shared')).toEqual(['shared 0']);
    expect(headersOf(groups, 'journal')).toEqual(['daily 0', 'cycles 0']);
  });

  it('splits long_term by heading: rule-named headings go to Rules, the rest to How I work', () => {
    const groups = groupSections([named('long_term', ['Overview', 'Rules', 'Never force-push', 'Host notes', 'Don\'t run find /'])]);
    expect(headersOf(groups, 'rules')).toEqual(['Rules', 'Never force-push', 'Don\'t run find /']);
    expect(headersOf(groups, 'how')).toEqual(['Overview', 'Host notes']);
  });

  it('shows a single untitled long_term note under How I work with no empty Rules group', () => {
    const groups = groupSections([named('long_term', ['Overview'])]);
    expect(groups.find((g) => g.id === 'rules').sections).toEqual([]);
    expect(headersOf(groups, 'how')).toEqual(['Overview']);
  });

  it('falls back to How I work for an unknown section so nothing is hidden', () => {
    const groups = groupSections([section('brand_new_key')]);
    expect(headersOf(groups, 'how')).toEqual(['brand_new_key 0']);
  });

  it('carries the section update time onto its group sections and splits it with long_term', () => {
    const at = '2026-10-30T12:00:00.000Z';
    const groups = groupSections([{ ...named('long_term', ['Rules', 'Overview']), updatedAt: at }]);
    expect(groups.find((g) => g.id === 'rules').sections[0].updatedAt).toBe(at);
    expect(groups.find((g) => g.id === 'how').sections[0].updatedAt).toBe(at);
  });
});

describe('V2AgentMemory', () => {
  it('renders the three groups from the owner index', async () => {
    axios.get.mockResolvedValue({ data: {
      viewerRole: 'owner', totalEntries: 3,
      sections: [named('long_term', ['Rules', 'Host notes']), section('daily', 1)],
    } });
    render(
      <MemoryRouter initialEntries={['/v2/agents/maya-claude/default/memory']}>
        <Routes>
          <Route path="/v2/agents/:agentName/:instanceId/memory" element={<V2AgentMemory />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('heading', { name: /Rules/ })).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: /How I work/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Journal/ })).toBeInTheDocument();
    expect(axios.get).toHaveBeenCalledWith('/api/agent-memory/maya-claude/default');
  });

  it('filters notes by the search box and keeps only groups that still match', async () => {
    axios.get.mockResolvedValue({ data: {
      viewerRole: 'owner', totalEntries: 3,
      sections: [named('long_term', ['Rules', 'Host notes']), section('daily', 1)],
    } });
    render(
      <MemoryRouter initialEntries={['/v2/agents/maya-claude/default/memory']}>
        <Routes>
          <Route path="/v2/agents/:agentName/:instanceId/memory" element={<V2AgentMemory />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('heading', { name: /Journal/ })).toBeInTheDocument());
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'host' } });
    expect(screen.getByText('Host notes')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Journal/ })).toBeNull();
  });

  it('shows the section update time once per group and never on a note', async () => {
    axios.get.mockResolvedValue({ data: {
      viewerRole: 'owner', totalEntries: 3,
      sections: [
        { ...named('long_term', ['Rules', 'Host notes']), updatedAt: '2026-10-30T12:00:00.000Z' },
        section('daily', 1),
      ],
    } });
    render(
      <MemoryRouter initialEntries={['/v2/agents/maya-claude/default/memory']}>
        <Routes>
          <Route path="/v2/agents/:agentName/:instanceId/memory" element={<V2AgentMemory />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('heading', { name: /Journal/ })).toBeInTheDocument());
    // Rules and How I work each carry the long_term time; Journal has none.
    expect(document.querySelectorAll('.v2m-saved')).toHaveLength(2);
    expect(document.querySelectorAll('.v2m-mnote .v2m-saved')).toHaveLength(0);
  });

  it('keeps the agent header, tabs and nav when the viewer cannot read entries, and says the memory is private', async () => {
    axios.get.mockImplementation((url) => (url.startsWith('/api/agent-memory')
      ? Promise.reject(Object.assign(new Error('403'), { response: { status: 403 } }))
      : Promise.resolve({ data: { agent: { displayName: 'Maya' }, pods: { count: 2 } } })));
    render(
      <MemoryRouter initialEntries={['/v2/agents/maya-claude/default/memory']}>
        <Routes>
          <Route path="/v2/agents/:agentName/:instanceId/memory" element={<V2AgentMemory />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Profile' })).toBeInTheDocument();
    expect(document.querySelector('.v2m-mnav')).not.toBeNull();
    expect(document.querySelector('.v2m-body [role="status"]')).not.toBeNull();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent("Only Maya's owner and admins can read its memory."));
    expect(screen.queryByText('No memory recorded yet.')).toBeNull();
  });

  it('names a runtime-hosted agent by its instance, never the runtime, before its profile loads', async () => {
    axios.get.mockImplementation((url) => (url.startsWith('/api/agent-memory')
      ? Promise.reject(Object.assign(new Error('403'), { response: { status: 403 } }))
      : new Promise(() => {})));
    render(
      <MemoryRouter initialEntries={['/v2/agents/openclaw/aria/memory']}>
        <Routes>
          <Route path="/v2/agents/:agentName/:instanceId/memory" element={<V2AgentMemory />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent("Only aria's owner and admins can read its memory."));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('aria');
  });

  it('says the load failed, not that the agent has no memory, when the request errors', async () => {
    axios.get.mockRejectedValue(new Error('Network Error'));
    renderPage();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent("Memory didn't load. Refresh to try again."));
  });

  it('says no memory is recorded when the agent has none, and dashes every empty group', async () => {
    axios.get.mockResolvedValue({ data: { viewerRole: 'owner', totalEntries: 0, sections: [] } });
    renderPage();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('No memory recorded yet.'));
    const counts = Array.from(document.querySelectorAll('.v2m-mnav .mo')).map((n) => n.textContent);
    expect(counts).toEqual(['—', '—', '—', '—', '—']);
    expect(document.querySelectorAll('.v2m-mnav a')).toHaveLength(0);
  });

  it('says nothing matches when a search empties every group', async () => {
    axios.get.mockResolvedValue({ data: { viewerRole: 'owner', totalEntries: 1, sections: [section('daily', 1)] } });
    renderPage();
    await waitFor(() => expect(screen.getByRole('heading', { name: /Journal/ })).toBeInTheDocument());
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zebra' } });
    expect(screen.getByRole('status')).toHaveTextContent('No notes match “zebra”.');
  });

  it('prints journal days the way the frame does, and marks an empty day', async () => {
    axios.get.mockResolvedValue({ data: { viewerRole: 'owner', totalEntries: 2, sections: [{
      key: 'daily', label: 'Daily journal', kind: 'log',
      notes: [{ header: '2026-10-28', snippet: '#401 approved' }, { header: '2026-10-25', snippet: '' }],
    }] } });
    renderPage();
    await waitFor(() => expect(screen.getByText('#401 approved')).toBeInTheDocument());
    const days = Array.from(document.querySelectorAll('.v2m-jday .mo')).map((n) => n.textContent);
    expect(days).toEqual(['Oct 28', 'Oct 25']);
    expect(document.querySelector('.v2m-jday .v2m-mu')).toHaveTextContent('No entry');
  });

  it('Talk to opens the agent room and navigates to it', async () => {
    axios.get.mockResolvedValue({ data: { viewerRole: 'owner', totalEntries: 1, sections: [section('daily', 1)] } });
    axios.post.mockResolvedValue({ data: { room: { _id: 'room1' } } });
    render(
      <MemoryRouter initialEntries={['/v2/agents/maya-claude/default/memory']}>
        <Routes>
          <Route path="/v2/agents/:agentName/:instanceId/memory" element={<V2AgentMemory />} />
          <Route path="/v2/pods/:id" element={<div>room opened</div>} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('heading', { name: /Journal/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /maya-claude/ }));
    await waitFor(() => expect(screen.getByText('room opened')).toBeInTheDocument());
    expect(axios.post).toHaveBeenCalledWith('/api/agents/runtime/room', { agentName: 'maya-claude', instanceId: 'default' });
  });

  it('shows an error and stays on the page when the room cannot be opened', async () => {
    axios.get.mockResolvedValue({ data: { viewerRole: 'owner', totalEntries: 1, sections: [section('daily', 1)] } });
    axios.post.mockRejectedValue(new Error('500'));
    render(
      <MemoryRouter initialEntries={['/v2/agents/maya-claude/default/memory']}>
        <Routes>
          <Route path="/v2/agents/:agentName/:instanceId/memory" element={<V2AgentMemory />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('heading', { name: /Journal/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /maya-claude/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /maya-claude/ })).not.toBeDisabled();
  });

  it('marks one nav item current: the first with notes, then the one clicked', async () => {
    axios.get.mockResolvedValue({ data: { viewerRole: 'owner', totalEntries: 3, sections: [named('long_term', ['Rules', 'Host notes']), section('daily', 1)] } });
    render(
      <MemoryRouter initialEntries={['/v2/agents/maya-claude/default/memory']}>
        <Routes>
          <Route path="/v2/agents/:agentName/:instanceId/memory" element={<V2AgentMemory />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('heading', { name: /Journal/ })).toBeInTheDocument());
    const current = () => Array.from(document.querySelectorAll('.v2m-mnav a[aria-current]')).map((a) => a.textContent);
    expect(current()).toEqual(['Rules1']);
    fireEvent.click(screen.getByRole('link', { name: /Journal/ }));
    expect(current()).toEqual(['Journal1']);
  });
});

describe('latestDay', () => {
  it('takes the newest ISO day across daily and cycles, whatever their order', () => {
    const sec = (headers) => ({ key: 'x', label: 'x', updatedAt: null, notes: headers.map((header) => ({ header, snippet: '' })) });
    expect(latestDay([sec(['2026-10-25', '2026-10-24']), sec(['2026-10-28'])])).toBe('2026-10-28');
    expect(latestDay([sec(['Heartbeat 3'])])).toBe('Heartbeat 3');
  });
});

describe('journalDay', () => {
  it('formats an ISO day for the reader and leaves anything else alone', () => {
    expect(journalDay('2026-10-28', 'en')).toBe('Oct 28');
    expect(journalDay('2026-10-28', 'zh-CN')).toBe('10月28日');
    expect(journalDay('Heartbeat 12', 'en')).toBe('Heartbeat 12');
  });
});

describe('V2AgentMemory on a phone', () => {
  const realMatchMedia = window.matchMedia;
  beforeEach(() => {
    window.matchMedia = jest.fn().mockImplementation((query) => ({
      matches: query === '(max-width: 767px)', media: query,
      addEventListener: jest.fn(), removeEventListener: jest.fn(), addListener: jest.fn(), removeListener: jest.fn(),
    }));
  });
  afterEach(() => { window.matchMedia = realMatchMedia; });

  it('puts the tabs in a row below the bar, with a back button to Your team', async () => {
    axios.get.mockResolvedValue({ data: { viewerRole: 'owner', totalEntries: 1, sections: [section('daily', 1)] } });
    renderPage();
    await waitFor(() => expect(screen.getByRole('heading', { name: /Journal/ })).toBeInTheDocument());
    expect(document.querySelector('.v2p-ph .v2p-seg')).toBeNull();
    expect(document.querySelector('.v2m-pbody > .v2p-seg')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Your team' })).toBeInTheDocument();
  });

  it('opens only the first group, and titles carry the count and the latest journal day', async () => {
    axios.get.mockResolvedValue({ data: { viewerRole: 'owner', totalEntries: 4, sections: [
      named('long_term', ['Rules', 'Host notes']),
      { key: 'daily', label: 'Daily journal', kind: 'log', notes: [{ header: '2026-10-28', snippet: 'a' }, { header: '2026-10-27', snippet: 'b' }] },
    ] } });
    renderPage();
    await waitFor(() => expect(screen.getByRole('heading', { name: /Journal/ })).toBeInTheDocument());
    const open = Array.from(document.querySelectorAll('details.v2m-grp')).map((d) => [d.id, d.open]);
    expect(open).toEqual([['memory-group-rules', true], ['memory-group-how', false], ['memory-group-journal', false]]);
    expect(Array.from(document.querySelectorAll('.v2m-ct')).map((n) => n.textContent)).toEqual(['1', '1', '2']);
    expect(document.querySelector('#memory-group-journal .v2m-latest')).toHaveTextContent('Oct 28');
  });
});
