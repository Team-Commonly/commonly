import { isSoloHumanPod, teammateInviteMoment } from '../utils/teammateInviteMoment';
import type { V2Message } from '../hooks/useV2PodDetail';

const human = { _id: 'person', username: 'person', isBot: false };
const agent = { _id: 'bot', username: 'scout-person', isBot: true };
const msg = (id: string, user_id: string, username: string, isBot: boolean): V2Message => ({
  id, pod_id: 'pod', user_id, content: 'A useful answer', message_type: 'text', created_at: '', user: { username, isBot },
});
const ask = msg('2', 'person', 'person', false);
const answer = msg('3', 'bot', 'scout-person', true);
const agentKeys = new Set(['scout-person']);

test('only the sole human member of a group pod qualifies; unknown and DM members do not', () => {
  expect(isSoloHumanPod({ _id: 'pod', name: 'Work' }, [human, agent], 'person')).toBe(true);
  expect(isSoloHumanPod({ _id: 'pod', name: 'Work' }, [human, agent, { _id: 'other' }], 'person')).toBe(false);
  expect(isSoloHumanPod({ _id: 'pod', name: 'Work' }, [human, agent], 'outsider')).toBe(false);
  for (const type of ['agent-admin', 'agent-room', 'agent-dm']) {
    expect(isSoloHumanPod({ _id: 'pod', name: 'Work', type }, [human, agent], 'person')).toBe(false);
  }
});
test('waits for the person to ask, then chooses the first non-kernel agent reply', () => {
  expect(teammateInviteMoment([answer], 'person', agentKeys, agentKeys, false)).toBeNull();
  const welcome = { ...answer, id: '1' };
  const system = { ...answer, id: 'kernel', author_kind: 'kernel' as const };
  const failed = { ...answer, id: 'failed', metadata: { runFailed: true } };
  expect(teammateInviteMoment([welcome, ask, system, failed, answer], 'person', agentKeys, agentKeys, false))
    .toEqual({ messageId: '3', username: 'scout-person', source: 'first-agent-post' });
});
test('in the owned workspace Scout\'s answer never counts; the person\'s own agent\'s does, as its own placement (D288)', () => {
  expect(teammateInviteMoment([ask, answer], 'person', agentKeys, agentKeys, true)).toBeNull();
  const own = msg('4', 'mine', 'claude-code-laptop', true);
  expect(teammateInviteMoment([ask, answer, own], 'person', new Set(['scout-person', 'claude-code-laptop']), agentKeys, true))
    .toEqual({ messageId: '4', username: 'claude-code-laptop', source: 'workspace-own-agent' });
  expect(teammateInviteMoment([ask, own], 'person', new Set(['claude-code-laptop']), agentKeys, false)?.source).toBe('first-agent-post');
});
test('with only the latest page loaded, the latest agent post counts without a visible ask, and the same posts still never do', () => {
  const later = { ...answer, id: '5' };
  const system = { ...answer, id: 'kernel', author_kind: 'kernel' as const };
  const failed = { ...answer, id: 'failed', metadata: { runFailed: true } };
  const latestInView = { latestInView: true };
  expect(teammateInviteMoment([answer, later, system, failed], 'person', agentKeys, agentKeys, false, latestInView))
    .toEqual({ messageId: '5', username: 'scout-person', source: 'first-agent-post' });
  expect(teammateInviteMoment([system, failed, ask], 'person', agentKeys, agentKeys, false, latestInView)).toBeNull();
  // Scout's posts in the owned workspace still never carry it.
  expect(teammateInviteMoment([answer, later], 'person', agentKeys, agentKeys, true, latestInView)).toBeNull();
});
