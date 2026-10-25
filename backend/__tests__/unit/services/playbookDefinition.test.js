const { validatePlaybook } = require('../../../services/playbooks/definition');
const { preflightPlaybook } = require('../../../services/playbooks/preflight');
const { checkPlaybookDone } = require('../../../services/playbooks/doneCheck');

const entry = () => ({ v: 1,
  roles: [{ key: 'drafter', kind: 'agent' }, { key: 'checker', kind: 'agent' }, { key: 'sender', kind: 'person' }],
  steps: [
    { key: 'draft', title: 'Draft', role: 'drafter', do: 'Post the draft', delivers: 'post' },
    { key: 'check', title: 'Check', role: 'checker', do: 'Post PASS or the fix', delivers: 'post' },
    { key: 'send', title: 'Send manually', role: 'sender', do: 'Approve, send by hand, then complete',
      approval: { by: 'sender', act: 'actor', effect: 'none' }, writeGap: 'linkedin' },
  ],
  done: [
    { says: 'Drafted', check: 'done', step: 'draft' },
    { says: 'Checked', check: 'done', step: 'check' },
    { says: 'Approved', check: 'approved', step: 'send' },
    { says: 'Manual send recorded complete', check: 'done', step: 'send' },
    { says: 'Completed by the bound person', check: 'by-person', step: 'send' },
  ] });
const members = [
  { userId: 'a', handle: 'juno', kind: 'agent', runtime: 'byo', agentName: 'claude' },
  { userId: 'b', handle: 'piper', kind: 'agent', runtime: 'byo', agentName: 'codex' },
  { userId: 'c', handle: 'lily', kind: 'person' },
];
const bindings = { drafter: 'a', checker: 'b', sender: 'c' };
const context = { members, tools: [], grantPodRefusal: null };

test('the D8 actor-point person step validates and binds by user identity', () => {
  expect(preflightPlaybook(entry(), bindings, context).members.get('sender')).toEqual(members[2]);
});

test.each([
  (book) => { book.roles[1].key = 'drafter'; },
  (book) => { book.steps[1].key = 'draft'; },
  (book) => { book.steps[0].role = 'missing'; },
  (book) => { book.done[0].step = 'missing'; },
  (book) => { book.steps[2].approval.by = 'checker'; },
  (book) => { book.steps[0].writeGap = 'linkedin'; },
  (book) => { book.steps[2].approval.effect = 'post'; },
  (book) => { book.steps[0].do = ''; },
  (book) => { book.steps[0].unrecognized = true; },
  (book) => { book.roles[0].key = '$ne'; },
])('rejects malformed or unsupported contracts (%#)', (change) => {
  const book = entry(); change(book); expect(() => validatePlaybook(book)).toThrow();
});

test('a person-only playbook cannot hold a point', () => {
  const book = entry(); book.roles = [book.roles[2]]; book.steps = [book.steps[2]]; book.done = book.done.slice(2);
  expect(() => validatePlaybook(book)).toThrow('agent role');
});

test.each([
  [{ ...bindings, sender: 'outsider' }, context, 'current pod member'],
  [{ ...bindings, sender: 'a' }, context, 'person'],
  [{ ...bindings, extra: 'c' }, context, 'declared roles'],
  [bindings, { ...context, members: members.map((m) => m.userId === 'a' ? { ...m, runtime: undefined } : m) }, 'active agent'],
])('preflight refuses invalid live bindings (%#)', (bound, live, message) => {
  expect(() => preflightPlaybook(entry(), bound, live)).toThrow(message);
});

test('native PR writes are refused, while a BYO PR step remains valid', () => {
  const book = entry(); book.steps[0].delivers = 'pr';
  expect(preflightPlaybook(book, bindings, context).book).toEqual(book);
  expect(() => preflightPlaybook(book, bindings, { ...context,
    members: members.map((m) => m.userId === 'a' ? { ...m, runtime: 'native' } : m) })).toThrow('BYO');
});

test('reads require a live pinned read for the actor and an eligible grant pod', () => {
  const book = entry(); book.steps[0].reads = ['airtable.list_records_for_table'];
  expect(() => preflightPlaybook(book, bindings, context)).toThrow('not granted');
  const tools = [{ name: book.steps[0].reads[0], mode: 'read', audience: ['a'] }];
  expect(preflightPlaybook(book, bindings, { ...context, tools }).book).toEqual(book);
  expect(() => preflightPlaybook(book, bindings, { ...context, tools,
    grantPodRefusal: 'pod_bridged' })).toThrow('unbridged');
  expect(() => preflightPlaybook(book, bindings, { ...context,
    tools: [{ ...tools[0], mode: 'write-with-confirm' }] })).toThrow('write');
  expect(() => preflightPlaybook(book, bindings, { ...context,
    tools: [{ ...tools[0], audience: ['b'] }] })).toThrow('not granted');
});

const records = (send = {}) => new Map([
  ['draft', { status: 'done', completedBy: 'a' }],
  ['check', { status: 'done', completedBy: 'b' }],
  ['send', { status: 'done', ruling: { state: 'approved' }, completedBy: 'c', ...send }],
]);
test('approval alone never attests a manual send', () => {
  const result = checkPlaybookDone(entry(), records({ status: 'pending', completedBy: undefined }), new Set(['c']));
  expect(result.done).toBe(false); expect(result.failed).toContain('Manual send recorded complete');
});
test('a missing approval blocks even when the done list omits approval', () => {
  const book = entry(); book.done = book.done.filter((item) => item.check !== 'approved');
  expect(checkPlaybookDone(book, records({ ruling: undefined }), new Set(['c'])).done).toBe(false);
});
test('bot completion is refused even when the done list omits by-person', () => {
  const book = entry(); book.done = book.done.filter((item) => item.check !== 'by-person');
  expect(checkPlaybookDone(book, records({ completedBy: 'b' }), new Set(['c'])).done).toBe(false);
});
test('approval and recorded human completion satisfy the D8 done check', () => {
  expect(checkPlaybookDone(entry(), records(), new Set(['c']))).toEqual({ done: true, failed: [] });
});
