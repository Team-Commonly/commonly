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

  it('shows a denied notice instead of the index when the viewer is not owner or admin', async () => {
    axios.get.mockRejectedValue(new Error('403'));
    render(
      <MemoryRouter initialEntries={['/v2/agents/maya-claude/default/memory']}>
        <Routes>
          <Route path="/v2/agents/:agentName/:instanceId/memory" element={<V2AgentMemory />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: /Rules/ })).toBeNull();
  });
});
