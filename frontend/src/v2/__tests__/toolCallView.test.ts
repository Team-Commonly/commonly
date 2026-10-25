import { toolCallView } from '../components/toolCallView';

// The card is a consent surface: the readable view may relabel, but it must
// show every pinned argument, and it may only link to github.com paths built
// from validated values.
const merge = {
  pullNumber: 42,
  mergeMethod: 'squash',
  headSha: 'abc1234def5678abc1234def5678abc1234def56',
  owner: 'Team-Commonly',
  repo: 'demo-day',
};

const keysShown = (args: Record<string, unknown>, tool: string) => (
  toolCallView(tool, args).rows.flatMap((row) => row.keys).sort()
);

describe('toolCallView', () => {
  test('a merge reads as a verb with the repo, the PR, the pinned head and the method', () => {
    const view = toolCallView('github.merge_pull_request', merge);
    expect(view.verb).toEqual({ key: 'approvalCard.toolCall.verb.mergePullRequest', vars: { number: '42' } });
    const byKey = Object.fromEntries(view.rows.map((row) => [row.keys.join('+'), row]));
    expect(byKey['owner+repo']).toMatchObject({ value: 'Team-Commonly/demo-day', href: 'https://github.com/Team-Commonly/demo-day' });
    expect(byKey.pullNumber).toMatchObject({ value: '#42', href: 'https://github.com/Team-Commonly/demo-day/pull/42' });
    expect(byKey.headSha).toMatchObject({
      value: 'abc1234',
      title: merge.headSha,
      kind: 'mono',
      href: `https://github.com/Team-Commonly/demo-day/commit/${merge.headSha}`,
    });
    expect(byKey.mergeMethod).toMatchObject({ value: 'squash', labelKey: 'approvalCard.toolCall.label.mergeMethod' });
  });

  test('every pinned argument is shown, including ones the view has no name for', () => {
    const args = { ...merge, commitTitle: 'Fix #3', commitMessage: 'line one\nline two', extra: { nested: true } };
    expect(keysShown(args, 'github.merge_pull_request')).toEqual(Object.keys(args).sort());
    const extra = toolCallView('github.merge_pull_request', args).rows.find((row) => row.keys[0] === 'extra');
    expect(extra).toMatchObject({ label: 'extra', value: '{"nested":true}', kind: 'mono' });
    expect(extra?.labelKey).toBeUndefined();
  });

  test('a hosted-MCP call keeps its tool name and shows its arguments as plain rows', () => {
    const args = { parent: 'page-1', title: 'Weekly notes', properties: { status: 'draft' } };
    const view = toolCallView('notion.create_page', args);
    expect(view.verb).toBeNull();
    expect(keysShown(args, 'notion.create_page')).toEqual(Object.keys(args).sort());
    expect(view.rows.some((row) => row.href)).toBe(false);
  });

  test('a body stays one literal block, and labels read as a list', () => {
    const view = toolCallView('github.create_issue', {
      title: 'Bug', body: 'Steps:\n1. open\n2. <script>alert(1)</script>', labels: ['bug', 'p1'], owner: 'o', repo: 'r',
    });
    expect(view.verb).toEqual({ key: 'approvalCard.toolCall.verb.createIssue', vars: {} });
    const body = view.rows.find((row) => row.keys[0] === 'body');
    expect(body).toMatchObject({ kind: 'block', value: 'Steps:\n1. open\n2. <script>alert(1)</script>' });
    expect(view.rows.find((row) => row.keys[0] === 'labels')).toMatchObject({ value: 'bug, p1', kind: 'text' });
  });

  test('no link is built from an owner, repo, number or SHA that fails validation', () => {
    const view = toolCallView('github.merge_pull_request', {
      owner: 'evil.example/../x', repo: 'demo-day', pullNumber: 4, headSha: 'not-a-sha',
    });
    expect(view.rows.every((row) => row.href === undefined)).toBe(true);
    expect(view.rows.find((row) => row.keys[0] === 'headSha')).toMatchObject({ value: 'not-a-sha' });
    const bad = toolCallView('github.close_issue', { owner: 'o', repo: 'r', issueNumber: '3; drop' });
    expect(bad.rows.find((row) => row.keys[0] === 'issueNumber')).toMatchObject({ value: '3; drop' });
    expect(bad.rows.find((row) => row.keys[0] === 'issueNumber')?.href).toBeUndefined();
    // A numbered verb with no valid number falls back to the tool name rather than "#undefined".
    expect(bad.verb).toBeNull();
  });

  test('only github tools get github links', () => {
    const view = toolCallView('linear.create_issue', { owner: 'Team-Commonly', repo: 'demo-day', issueNumber: 3 });
    expect(view.rows.every((row) => row.href === undefined)).toBe(true);
  });
});

test.each(['toString', 'constructor', 'hasOwnProperty', '__proto__', 'extra'])('unknown argument %s retains its raw label', key => {
  const args = JSON.parse(JSON.stringify({ title:'Pinned title', [key]:'pinned-not-prose' }));
  const view = toolCallView('github.create_issue', args);
  const row = view.rows.find(candidate => candidate.keys.includes(key));
  expect(row).toMatchObject({ label:key, value:'pinned-not-prose' });
  expect(row?.labelKey).toBeUndefined();
  expect(keysShown(args,'github.create_issue')).toEqual(Object.keys(args).sort());
});

test.each(['toString','constructor','__proto__'])('unknown tool %s has no inherited verb', tool => {
  expect(toolCallView(tool,{issueNumber:1,extra:'kept'}).verb).toBeNull();
});


describe.each([
  ['github.merge_pull_request', 'mergePullRequest', 'pullNumber', 'issueNumber'],
  ['github.comment_on_issue', 'commentOnIssue', 'issueNumber', 'pullNumber'],
  ['github.close_issue', 'closeIssue', 'issueNumber', 'pullNumber'],
])('%s number selection', (tool, verb, required, irrelevant) => {
  test('uses the required field when both numbers differ', () => {
    expect(toolCallView(tool, { [required]: 42, [irrelevant]: 7 }).verb).toEqual({
      key: `approvalCard.toolCall.verb.${verb}`, vars: { number: '42' },
    });
  });

  test.each([undefined, 0, -1, 1.5, '42'])('invalid required number %s never uses the other field', invalid => {
    expect(toolCallView(tool, { [required]: invalid, [irrelevant]: 7 }).verb).toBeNull();
  });
});
