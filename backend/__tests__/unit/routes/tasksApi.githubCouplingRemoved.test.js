const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Task = require('../../../models/Task');

const makeTask = (overrides = {}) => ({
  podId: new mongoose.Types.ObjectId(),
  taskNum: 1,
  taskId: 'TASK-001',
  title: 'A task',
  status: 'pending',
  source: 'import',
  sourceRef: 'external:ticket:42',
  updates: [],
  ...overrides,
});

describe('task board is independent of GitHub', () => {
  it('does not persist legacy issue metadata while retaining generic provenance', () => {
    const task = new Task(makeTask({
      githubIssueNumber: 42,
      githubIssueUrl: 'https://github.com/Team-Commonly/commonly/issues/42',
      githubIssueOwned: true,
    })).toObject();

    expect(task).toEqual(expect.objectContaining({
      source: 'import',
      sourceRef: 'external:ticket:42',
    }));
    expect(task).not.toHaveProperty('githubIssueNumber');
    expect(task).not.toHaveProperty('githubIssueUrl');
    expect(task).not.toHaveProperty('githubIssueOwned');
  });

  // The needles, kept in one place so the assertion below and the liveness
  // control below THAT cannot drift apart. `createGithubIssue` used to be a
  // third needle here and was removed: it existed nowhere in the tree except
  // inside this file's own regex, so it could never match and never fail —
  // a third of the alternation was decorative (@sprint-review, 58470).
  const COUPLING_NEEDLES = [
    // [needle, a file that must still contain it]
    ['GitHubAppService', 'services/githubAppService.ts'],
    ['githubIssue', 'scripts/remove-task-github-fields.ts'],
  ];

  const read = (rel) => fs.readFileSync(path.join(__dirname, '../../../', rel), 'utf8');

  it('does not give the task route a GitHub write path', () => {
    const routeSource = read('routes/tasksApi.ts');

    // POSITIVE CONTROL. Without it, this test proves only that some string
    // lacks some substrings — an empty read, a truncated file, or the wrong
    // path would all pass the negative assertion silently. readFileSync
    // throwing covers a MISSING file; it does not cover a present-but-wrong
    // one.
    //
    // The precise form matters, and "add a positive control" is too weak a
    // prescription (@sprint-review): the control must be a needle you know is
    // present in THAT SAME haystack, asserted from THAT SAME variable. A
    // passing assertion elsewhere in the file proves nothing about this read
    // — it can be green while this particular readFileSync returned something
    // no one intended.
    expect(routeSource).toMatch(/router\.(get|post|patch|put|delete)\(/);
    expect(routeSource.length).toBeGreaterThan(1000);

    for (const [needle] of COUPLING_NEEDLES) {
      expect(routeSource).not.toContain(needle);
    }
  });

  // The control that makes the assertion above mean something. A negative
  // match passes for two different reasons — the coupling is gone, or the
  // needle no longer names anything. Rename GitHubAppService and the route
  // test goes green forever with the coupling fully present; this one reddens
  // instead and forces the needle to be updated with the symbol.
  it('every needle still names a live symbol, so a rename cannot disarm the test', () => {
    for (const [needle, home] of COUPLING_NEEDLES) {
      expect(read(home)).toContain(needle);
    }
  });
});
