import React from 'react';
import { act, render } from '@testing-library/react';
import i18n, { i18nReady } from '../../i18n';
import { useDocumentTitleText } from '../hooks/useDocumentTitle';
import { podTabName } from '../utils/podTabName';

// A pod page's tab named only the app, so several open pods were
// indistinguishable. The tab now names the pod, or for a DM whoever the viewer
// is talking to. A pod that didn't load keeps the plain title.
const ME = 'u-me';
const me = { _id: ME, username: 'sam' };
const scout = { _id: 'b-1', username: 'scout-default', isBot: true, botMetadata: { displayName: 'Scout', instanceId: 'default' } };
const nova = { _id: 'b-2', username: 'openclaw-nova', isBot: true, botMetadata: { instanceId: 'nova' } };
const lee = { _id: 'u-2', username: 'lee' };

describe('podTabName', () => {
  test('a group pod uses its name', () => {
    expect(podTabName({ name: 'Launch room', type: 'chat' }, [me, lee, scout], ME, 'en')).toBe('Launch room');
  });

  test('a DM names the other party, not its stored "DM: …" name', () => {
    expect(podTabName({ name: 'DM: scout-default', type: 'agent-room' }, [me, scout], ME, 'en')).toBe('Scout');
    expect(podTabName({ name: 'DM: lee', type: 'agent-dm' }, [me, lee], ME, 'en')).toBe('lee');
  });

  test('an agent without a display name falls back to its instance, then its username', () => {
    expect(podTabName({ name: 'x', type: 'agent-room' }, [me, nova], ME, 'en')).toBe('nova');
    const bare = { _id: 'b-3', username: 'pi-default', isBot: true, botMetadata: { instanceId: 'default' } };
    expect(podTabName({ name: 'x', type: 'agent-room' }, [me, bare], ME, 'en')).toBe('pi-default');
  });

  test("an owner's room with their agent names the agent", () => {
    expect(podTabName({ name: 'DM: Scout', type: 'agent-admin' }, [me, lee, scout], ME, 'en')).toBe('Scout');
  });

  test("an observer of two agents' DM sees both, in the reader's language", () => {
    expect(podTabName({ name: 'x', type: 'agent-dm' }, [scout, nova], ME, 'en')).toBe('Scout and nova');
    expect(podTabName({ name: 'x', type: 'agent-dm' }, [scout, nova], ME, 'zh-CN')).toBe('Scout和nova');
  });

  test('nothing to name gives null: no pod, or a DM whose members have not loaded', () => {
    expect(podTabName(null, [], ME, 'en')).toBeNull();
    expect(podTabName({ name: 'DM: scout', type: 'agent-room' }, [], ME, 'en')).toBeNull();
    expect(podTabName({ name: '  ', type: 'chat' }, [], ME, 'en')).toBeNull();
  });
});

const Probe: React.FC<{ name: string | null }> = ({ name }) => {
  useDocumentTitleText(name);
  return null;
};

describe('useDocumentTitleText', () => {
  beforeAll(async () => { await i18nReady; });
  beforeEach(() => { document.title = 'Commonly'; });
  afterAll(async () => { await act(async () => { await i18n.changeLanguage('en'); }); });

  test('names the tab "<name> · Commonly" and restores the plain title on unmount', async () => {
    await act(async () => { await i18n.changeLanguage('en'); });
    const { unmount } = render(<Probe name="Launch room" />);
    expect(document.title).toBe('Launch room · Commonly');
    unmount();
    expect(document.title).toBe('Commonly');
  });

  test('zh-CN uses its own format', async () => {
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    render(<Probe name="发布" />);
    expect(document.title).toBe('发布 · Commonly');
  });

  test('a pod that did not load leaves the plain title', async () => {
    await act(async () => { await i18n.changeLanguage('en'); });
    render(<Probe name={null} />);
    expect(document.title).toBe('Commonly');
  });

  test('moving from one pod to the next names the next one', async () => {
    await act(async () => { await i18n.changeLanguage('en'); });
    const { rerender } = render(<Probe name="First" />);
    rerender(<Probe name="Second" />);
    expect(document.title).toBe('Second · Commonly');
  });
});
