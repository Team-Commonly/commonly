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

const open = (query, username = 'laruiss') => {
  const draft = `@${query}`;
  const inputRef = { current: { selectionStart: draft.length, focus: jest.fn(), setSelectionRange: jest.fn() } };
  const wrapper = ({ children }) => <AuthContext.Provider value={auth(username)}>{children}</AuthContext.Provider>;
  const { result } = renderHook(() => useV2ThreadMentions({
    members, agents, agentStateByHandle: new Map(), draft, setDraft: jest.fn(), inputRef,
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

  test('someone else signed in sees laruiss as a member', () => {
    expect(open('lar', 'larissa')).toContain('laruiss');
  });
});
