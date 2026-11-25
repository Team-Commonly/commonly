// @ts-nocheck
// The @ picker (C14 rehearsal, 2026-10-20): typing "@eng" listed the person's
// own account first and the agent second, so Enter mentioned themself and the
// agent never woke. The picker never offers your own handle, and among matches
// it puts prefix matches first and agents before people.
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { AuthContext } from '../../context/AuthContext';
import { useV2ThreadMentions } from '../hooks/useV2ThreadMentions';

const auth = (username) => ({
  currentUser: { _id: 'u-self', username }, user: { _id: 'u-self', username }, token: 't', loading: false,
  error: null, isAuthenticated: true, register: jest.fn(), login: jest.fn(), logout: jest.fn(), updateProfile: jest.fn(),
});

const members = [
  { _id: 'u-self', username: 'laruiss' },
  { _id: 'u-other', username: 'larissa' },
  { _id: 'u-agnes', username: 'agnes' },
  { _id: 'b-1', username: 'laruiss-agent' },
];
const agents = [{ agentName: 'laruiss-agent', instanceId: 'default', displayName: 'laruiss-agent' }];

const open = (query, username = 'laruiss', podMembers = members) => {
  const draft = `@${query}`;
  const inputRef = { current: { selectionStart: draft.length, focus: jest.fn(), setSelectionRange: jest.fn() } };
  const wrapper = ({ children }) => <AuthContext.Provider value={auth(username)}>{children}</AuthContext.Provider>;
  const { result } = renderHook(() => useV2ThreadMentions({
    members: podMembers, agents, agentStateByHandle: new Map(), draft, setDraft: jest.fn(), inputRef,
  }), { wrapper });
  act(() => { result.current.updateMentionState(draft, draft.length); });
  return result.current.filteredMentions.map((item) => item.value || item.label);
};

describe('@ picker', () => {
  test('never offers your own handle', () => {
    expect(open('lar')).not.toContain('laruiss');
  });

  test('the agent comes first, so Enter picks it', () => {
    expect(open('lar')[0]).toBe('laruiss-agent');
  });

  test('other people are still offered, after the agent', () => {
    const list = open('lar');
    expect(list).toContain('larissa');
    expect(list.indexOf('laruiss-agent')).toBeLessThan(list.indexOf('larissa'));
  });

  test('a prefix match outranks a match in the middle, even a person over an agent', () => {
    // "ag" is a prefix of agnes and only inside laruiss-agent: the person
    // typing "@ag" means agnes.
    const list = open('ag');
    expect(list).toEqual(expect.arrayContaining(['agnes', 'laruiss-agent']));
    expect(list[0]).toBe('agnes');
  });

  // sprint-review on #2366: with more matches than the picker shows, ranking
  // must happen before the cap, or an agent late in pod order drops out.
  test('ranking happens before the 8-item cap: the agent last in pod order still leads', () => {
    const crowd = Array.from({ length: 10 }, (_, i) => ({ _id: `u-${i}`, username: `lar${i}` }));
    const list = open('lar', 'laruiss', [...crowd, { _id: 'b-1', username: 'laruiss-agent' }]);
    expect(list).toHaveLength(8);
    expect(list[0]).toBe('laruiss-agent');
  });

  test('the self-skip ignores case', () => {
    expect(open('lar', 'LaRuiss')).not.toContain('laruiss');
  });

  test('someone else signed in sees laruiss as a member', () => {
    expect(open('lar', 'larissa')).toContain('laruiss');
  });
});

// F607: a pod can hold a default install and a sibling of the same agent. The
// bare name then routes to whichever install the backend's loose display-slug
// key gave it last, so picking the default inserts its explicit
// `<agentName>-default` key, which always reaches it. A lone default keeps the
// bare handle, and a sibling keeps its own handle.
describe('@ picker beside a sibling install (F607)', () => {
  const dflt = { agentName: 'codex', instanceId: 'default' };
  const ops = { agentName: 'codex', instanceId: 'ops' };

  const pick = (podAgents, query = 'codex') => {
    const draft = `@${query}`;
    const setDraft = jest.fn();
    const inputRef = { current: { selectionStart: draft.length, focus: jest.fn(), setSelectionRange: jest.fn() } };
    const wrapper = ({ children }) => <AuthContext.Provider value={auth('laruiss')}>{children}</AuthContext.Provider>;
    const { result } = renderHook(() => useV2ThreadMentions({
      members: [], agents: podAgents, agentStateByHandle: new Map(), draft, setDraft, inputRef,
    }), { wrapper });
    act(() => { result.current.updateMentionState(draft, draft.length); });
    return {
      values: result.current.filteredMentions.map((item) => item.value),
      insert: (value) => {
        const item = result.current.filteredMentions.find((row) => row.value === value);
        act(() => { result.current.selectMention(item); });
        return setDraft.mock.calls[0][0];
      },
    };
  };

  test('picking the default beside a sibling inserts @codex-default', () => {
    const { values, insert } = pick([dflt, ops]);
    expect(values).toEqual(expect.arrayContaining(['codex-default', 'ops']));
    expect(values).not.toContain('codex');
    expect(insert('codex-default')).toBe('@codex-default ');
  });

  test('the sibling listed first still gives the default its explicit handle', () => {
    expect(pick([ops, dflt]).values).toEqual(expect.arrayContaining(['codex-default', 'ops']));
  });

  test('a lone default keeps the bare @codex', () => {
    const { values, insert } = pick([dflt]);
    expect(values).toEqual(['codex']);
    expect(insert('codex')).toBe('@codex ');
  });

  test('the sibling inserts its own handle, as before', () => {
    expect(pick([dflt, ops]).insert('ops')).toBe('@ops ');
  });

  test('a different agent beside the default is not a sibling', () => {
    expect(pick([dflt, { agentName: 'claude', instanceId: 'ops' }]).values).toContain('codex');
  });
});
