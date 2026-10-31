// @ts-nocheck
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
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

describe('groupSections', () => {
  it('puts each known section in its group', () => {
    const groups = groupSections([section('soul'), section('long_term'), section('shared'), section('daily')]);
    const byId = Object.fromEntries(groups.map((g) => [g.id, g.sections.map((s) => s.key)]));
    expect(byId.rules).toEqual(['soul', 'long_term']);
    expect(byId.how).toEqual(['shared']);
    expect(byId.journal).toEqual(['daily']);
  });

  it('falls back to How I work for an unknown section so nothing is hidden', () => {
    const groups = groupSections([section('brand_new_key')]);
    expect(groups.find((g) => g.id === 'how').sections.map((s) => s.key)).toEqual(['brand_new_key']);
  });
});

describe('V2AgentMemory', () => {
  it('renders the three groups from the owner index', async () => {
    axios.get.mockResolvedValue({ data: {
      viewerRole: 'owner', totalEntries: 3,
      sections: [section('long_term', 2), section('daily', 1)],
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
