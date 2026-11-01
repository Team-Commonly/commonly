// @ts-nocheck
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import V2AgentMemory, { groupSections } from '../agents/V2AgentMemory';

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
const headersOf = (groups, id) => groups.find((g) => g.id === id).sections.flatMap((s) => s.notes.map((n) => n.header));

describe('groupSections', () => {
  it('puts soul first in Rules and journal sections in Journal', () => {
    const groups = groupSections([section('daily'), section('soul'), section('cycles')]);
    expect(headersOf(groups, 'rules')).toEqual(['soul 0']);
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

  it('keeps the agent header, tabs and nav when the viewer cannot read entries, with the empty state inside', async () => {
    axios.get.mockRejectedValue(new Error('403'));
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
});
