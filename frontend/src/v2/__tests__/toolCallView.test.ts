import { canShowToolCall, prWriteView, toolCallView } from '../components/toolCallView';

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
    expect(view.rows.find((row) => row.keys[0] === 'labels')).toMatchObject({ value: '["bug","p1"]', kind: 'text' });
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

  test('another tool keeps owner, repo, number and SHA keys as plain rows under their own names', () => {
    const view = toolCallView('linear.create_issue', { owner: 'alice', repo: 'notes', issueNumber: 3, headSha: 'abc1234' });
    expect(view.rows.map((row) => row.keys)).toEqual([['owner'], ['repo'], ['issueNumber'], ['headSha']]);
    expect(view.rows.every((row) => row.labelKey === undefined)).toBe(true);
    expect(view.rows.map((row) => row.value)).toEqual(['alice', 'notes', '3', 'abc1234']);
  });

  test('a multi-line string keeps its line breaks whatever its key', () => {
    const view = toolCallView('linear.create_issue', { description: 'one\ntwo', team: 'ENG' });
    expect(view.rows.find((row) => row.keys[0] === 'description')).toMatchObject({ kind: 'block' });
    expect(view.rows.find((row) => row.keys[0] === 'team')).toMatchObject({ kind: 'text' });
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


test.each(['.', '..'])('dot segment %s never creates a GitHub link', segment => {
  for (const args of [{ owner: segment, repo: 'valid-repo' }, { owner: 'valid-owner', repo: segment }]) {
    const view = toolCallView('github.merge_pull_request', { ...args, pullNumber: 42, headSha: 'abc1234' });
    expect(view.rows.every(row => row.href === undefined)).toBe(true);
  }
});

test('label boundaries remain distinct when a label contains a comma', () => {
  const labelsRow = (labels: string[]) => toolCallView('github.create_issue', { labels }).rows[0];
  const comma = labelsRow(['security, urgent', 'p1']);
  const separate = labelsRow(['security', 'urgent', 'p1']);
  expect(comma.value).not.toBe(separate.value);
  expect(JSON.parse(comma.value)).toEqual(['security, urgent', 'p1']);
  expect(JSON.parse(separate.value)).toEqual(['security', 'urgent', 'p1']);
});

// These fixtures are the shapes prWriteApprovalSummary sends, not a tidier copy:
// `message` is an object, and a file past the cap has empty content.
describe('a PR write summary', () => {
  const sha = 'a'.repeat(40);
  const file = (path: string, content: string, bytes: number, truncated = false) => ({
    path, bytes, content, truncated,
  });
  const commit = {
    repo: 'Team-Commonly/d14-walk-sandbox',
    base: 'main',
    head: 'walk/one',
    lands: 'new branch walk/one from main at aaaaaaa',
    subject: 'add notes',
    message: {
      label: 'Full commit message, exactly as it will be recorded',
      text: 'add notes\n\nwith a body',
      length: 21,
      truncated: false,
    },
    files: [file('a.md', 'first', 5), file('b.md', 'second', 6)],
    contents: { label: 'File contents', shownBytes: 11, totalBytes: 11, truncated: false },
    fileCount: 2,
    parentSha: sha,
    branchExists: false,
  };
  const row = (view: ReturnType<typeof prWriteView>, key: string) => view.rows.find((r) => r.keys[0] === key);

  test('every key but the byte total lands in a row, and every file gets its own', () => {
    const view = prWriteView('github.commit_files', commit);
    const shown = new Set(view.rows.map((r) => r.keys[0]));
    Object.keys(commit).filter((key) => key !== 'contents').forEach((key) => expect(shown.has(key)).toBe(true));
    expect(view.rows.filter((r) => r.keys[0] === 'files').map((r) => [r.value, r.detail]))
      .toEqual([['a.md', 'first'], ['b.md', 'second']]);
    expect(view.notices).toEqual([]);
  });

  test('the commit message is its text, not the object carrying it', () => {
    const view = prWriteView('github.commit_files', commit);
    expect(row(view, 'message')).toMatchObject({ value: 'add notes\n\nwith a body', kind: 'block' });
  });

  test('a path never becomes a row label, so a file called Repository reads as a file', () => {
    const view = prWriteView('github.commit_files', { files: [file('Repository', 'x', 1)] });
    expect(view.rows[0]).toMatchObject({
      labelKey: 'approvalCard.toolCall.label.file', label: 'file', value: 'Repository',
    });
  });

  test('a file past the cap says it is not shown, and never reads as an empty file', () => {
    const view = prWriteView('github.commit_files', {
      files: [file('src/auth.js', '', 1680, true)],
      contents: { shownBytes: 65536, totalBytes: 67216, truncated: true },
    });
    expect(view.rows[0].detail).toBeUndefined();
    expect(view.rows[0].note).toEqual({ key: 'approvalCard.toolCall.file.notShown', vars: { bytes: '1680' } });
    expect(view.notices).toEqual([{
      key: 'approvalCard.toolCall.notice.contentsCut', vars: { shown: '65536', total: '67216' },
    }]);
  });

  test('a really empty file stays an empty file, and a cut one says so', () => {
    const view = prWriteView('github.commit_files', {
      files: [file('empty', '', 0), file('long', 'start', 90000, true)],
    });
    expect(view.rows[0]).toMatchObject({ detail: '', note: { key: 'approvalCard.toolCall.file.size' } });
    expect(view.rows[1]).toMatchObject({ detail: 'start', note: { key: 'approvalCard.toolCall.file.cut' } });
  });

  test('a cut commit message and a cut PR body each get a notice', () => {
    const cutMessage = prWriteView('github.commit_files', {
      message: { text: 'start', length: 9000, truncated: true },
    });
    expect(cutMessage.notices).toEqual([{ key: 'approvalCard.toolCall.notice.messageCut', vars: { total: '9000' } }]);
    const body = prWriteView('github.create_pull_request', { bodyPreview: 'abc', bodyLength: 3000 });
    expect(body.notices).toEqual([{ key: 'approvalCard.toolCall.notice.bodyCut', vars: { shown: '3', total: '3000' } }]);
    expect(prWriteView('github.create_pull_request', { bodyPreview: 'abc', bodyLength: 3 }).notices).toEqual([]);
  });

  test('a push always says its contents are not shown', () => {
    const view = prWriteView('github.push_branch', {
      repo: 'a/b', head: 'x', baseOid: sha, newOid: sha, bundleBytes: 2048,
    });
    expect(view.notices).toEqual([{ key: 'approvalCard.toolCall.notice.pushContents', vars: {} }]);
    expect(row(view, 'bundleBytes')?.value).toBe('2048 B');
  });

  test('a boolean reads as a yes or no', () => {
    expect(row(prWriteView('github.create_pull_request', { draft: true }), 'draft'))
      .toMatchObject({ valueKey: 'approvalCard.toolCall.yes' });
    expect(row(prWriteView('github.commit_files', commit), 'branchExists'))
      .toMatchObject({ valueKey: 'approvalCard.toolCall.no' });
  });

  test('a key the view has never heard of is still shown under its own name', () => {
    const { rows } = prWriteView('github.commit_files', { newField: 'still here' });
    expect(rows).toEqual([expect.objectContaining({ label: 'newField', value: 'still here' })]);
  });

  test('a commit id is shortened with the full id one hover away, and the repo links to GitHub', () => {
    const view = prWriteView('github.commit_files', commit);
    expect(row(view, 'parentSha')).toMatchObject({ value: 'aaaaaaa', title: sha, kind: 'mono' });
    expect(row(view, 'repo')).toMatchObject({ href: 'https://github.com/Team-Commonly/d14-walk-sandbox' });
  });

  test('a repo that is not a plain owner/name never becomes a link', () => {
    ['../evil', 'a/b/c', 'owner/..', 'no-slash'].forEach((repo) => {
      expect(prWriteView('github.push_branch', { repo }).rows[0].href).toBeUndefined();
    });
  });

  test('each tool has its verb, and one with no branch to name has none', () => {
    expect(prWriteView('github.create_pull_request', {}).verb)
      .toEqual({ key: 'approvalCard.toolCall.verb.createPullRequest', vars: {} });
    expect(prWriteView('github.commit_files', { head: 'x' }).verb)
      .toEqual({ key: 'approvalCard.toolCall.verb.commitFiles', vars: { head: 'x' } });
    expect(prWriteView('github.push_branch', { head: 'x' }).verb)
      .toEqual({ key: 'approvalCard.toolCall.verb.pushBranch', vars: { head: 'x' } });
    expect(prWriteView('github.commit_files', {}).verb).toBeNull();
  });

  test.each([
    ['no tool', { summary: { repo: 'a/b' } }, false],
    ['neither arguments nor a summary', { tool: 'github.commit_files' }, false],
    ['a list for arguments', { tool: 'github.create_issue', canonicalArgs: ['x'] }, false],
    ['a summary that is not an object', { tool: 'github.commit_files', summary: 'trust me' }, false],
    ['an empty summary', { tool: 'github.commit_files', summary: {} }, false],
    ['a summary on a tool that has none', { tool: 'github.create_issue', summary: { repo: 'a/b' } }, false],
    ['arguments', { tool: 'github.create_issue', canonicalArgs: { title: 'x' } }, true],
    ['a summary on a PR write', { tool: 'github.commit_files', summary: { repo: 'a/b' } }, true],
  ])('canShowToolCall with %s', (_label, envelope, expected) => {
    expect(canShowToolCall(envelope)).toBe(expected);
  });
});
