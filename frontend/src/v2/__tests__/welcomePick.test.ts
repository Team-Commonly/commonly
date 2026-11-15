// The filled keys on Scout's welcome follow the person's pick.
import { orderStarts, primaryStartIds } from '../utils/welcomePick';

const HOSTED = { id: 'run-hosted', label: 'Run an agent here', action: 'run-hosted' };
const ASK = { id: 'ask-scout', label: 'Show me what you can do' };
const CONNECT = { id: 'connect-agent', label: 'Connect an agent I already use' };
const POD = { id: 'start-pod', label: 'Start a pod for a project' };
const OPEN_BYO = { id: 'open-byo', label: 'Open Bring your own', href: '/v2/agents/byo?pod=p' };
const welcome = [HOSTED, ASK, CONNECT, POD];
const ids = (set: Set<string>) => [...set].sort();

test('no pick: hosting and connecting together, as equal choices', () => {
  expect(ids(primaryStartIds(welcome, null))).toEqual(['connect-agent', 'run-hosted']);
});
test('picked hosted: only the hosted start', () => {
  expect(ids(primaryStartIds(welcome, 'hosted'))).toEqual(['run-hosted']);
});
test('picked bring-your-own: only the connect start; a group without one has no filled key', () => {
  expect(ids(primaryStartIds(welcome, 'byo'))).toEqual(['connect-agent']);
  expect(ids(primaryStartIds([HOSTED, ASK, POD], 'byo'))).toEqual([]);
  expect(ids(primaryStartIds([OPEN_BYO], 'byo'))).toEqual(['open-byo']);
});
test('no hosting offered: the start that asks nothing, whatever the pick', () => {
  expect(ids(primaryStartIds([ASK, CONNECT, POD], null))).toEqual(['ask-scout']);
  expect(ids(primaryStartIds([ASK, CONNECT, POD], 'hosted'))).toEqual(['ask-scout']);
});
test('filled keys come first, the rest keep the order sent', () => {
  expect(orderStarts(welcome, primaryStartIds(welcome, null)).map((s) => s.id)).toEqual(['run-hosted', 'connect-agent', 'ask-scout', 'start-pod']);
});
