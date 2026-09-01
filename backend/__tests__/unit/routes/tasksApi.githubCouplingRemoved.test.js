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

  // The escape those two needles cannot close (@sprint-review, 58544): an
  // import alias. `import GH from '../services/githubAppService'` reintroduces
  // the coupling in full while `GitHubAppService` never appears in the route
  // source — both needles stay absent, both assertions above stay green.
  //
  // A blanket /github/i over the whole file would close it, and would also
  // redden on a comment explaining the decoupling. That is a false failure
  // someone eventually hits and then deletes the test over. Assert over the
  // module SPECIFIERS instead: coupling has to arrive through one, and a
  // comment is never one.
  const MODULE_SPECIFIER_RE = /(?:from\s*|require\(\s*|import\(\s*)['"]([^'"]+)['"]/g;
  const specifiersOf = (src) => [...src.matchAll(MODULE_SPECIFIER_RE)].map((m) => m[1]);

  it('imports no GitHub module under any name, aliased or otherwise', () => {
    const specifiers = specifiersOf(read('routes/tasksApi.ts'));

    // Same-haystack control as above. An extraction that returned [] would
    // satisfy the negative assertion perfectly and prove nothing.
    expect(specifiers).toContain('../models/Task');
    expect(specifiers).toContain('../services/taskEventService');
    expect(specifiers.length).toBeGreaterThan(5);

    expect(specifiers.filter((s) => /github/i.test(s))).toEqual([]);
  });

  it('the specifier extractor still fires on a GitHub import, so the check cannot go blind', () => {
    // Liveness for the INSTRUMENT, not the symbol. The needle control above
    // proves a name is still live; this proves the regex still matches. A
    // control that fails to construct is indistinguishable from an instrument
    // that cannot detect, so plant the thing being denied and see it caught.
    const planted = [
      "import GH from '../services/githubAppService';",
      "const gh = require('../services/githubAppService');",
      "const lazy = await import('../services/githubAppService');",
    ].join('\n');

    expect(specifiersOf(planted).filter((s) => /github/i.test(s))).toEqual([
      '../services/githubAppService',
      '../services/githubAppService',
      '../services/githubAppService',
    ]);
  });
});
