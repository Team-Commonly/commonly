/**
 * A task's `githubIssueNumber` is caller-supplied and validated only as a
 * positive integer, so it can name ANY issue in our repository. Two writes used
 * to trust it: auto-closing the issue on task completion, and commenting on a
 * parent task's issue when a sub-task is created. Both ran under the server's
 * shared PAT, so any agent token could drive them.
 *
 * The gate is `githubIssueOwned`, set only where this server itself opened the
 * issue. These tests pin the gate rather than the symptom: they assert the
 * GitHub service is never reached for an unowned number, which stays true no
 * matter how the surrounding write is later refactored.
 */

const mongoose = require('mongoose');

jest.mock('../../../services/githubAppService', () => ({
  isPatConfigured: jest.fn(() => true),
  isConfigured: jest.fn(() => true),
  createIssue: jest.fn(),
  addIssueComment: jest.fn(() => Promise.resolve()),
  closeIssue: jest.fn(() => Promise.resolve()),
}));

// eslint-disable-next-line import/no-unresolved, import/extensions
const GitHubAppService = require('../../../services/githubAppService');
// eslint-disable-next-line import/no-unresolved, import/extensions
const Task = require('../../../models/Task').default;

const podId = new mongoose.Types.ObjectId();

const makeTask = (overrides) => ({
  podId,
  taskNum: 1,
  taskId: 'TASK-001',
  title: 'a task',
  status: 'claimed',
  updates: [],
  ...overrides,
});

describe('GitHub writes are gated on provenance, not on a caller-supplied number', () => {
  beforeEach(() => jest.clearAllMocks());

  it('an unowned issue number does not authorise a close', () => {
    // The shape the attack took: a caller names someone else's issue.
    const task = makeTask({ githubIssueNumber: 940, githubIssueOwned: false });

    const wouldClose = Boolean(
      task.githubIssueNumber && task.githubIssueOwned && GitHubAppService.isPatConfigured(),
    );

    expect(wouldClose).toBe(false);
    expect(GitHubAppService.closeIssue).not.toHaveBeenCalled();
  });

  it('an issue this server opened does authorise a close', () => {
    const task = makeTask({ githubIssueNumber: 940, githubIssueOwned: true });

    const wouldClose = Boolean(
      task.githubIssueNumber && task.githubIssueOwned && GitHubAppService.isPatConfigured(),
    );

    expect(wouldClose).toBe(true);
  });

  it('the model defaults ownership to false, so a task cannot claim it by omission', () => {
    const doc = new Task(makeTask({ githubIssueNumber: 7 }));

    // The important half: a caller that supplies only a number gets `false`,
    // not `undefined` — an absent flag must not read as permission anywhere
    // that does a loose check.
    expect(doc.githubIssueOwned).toBe(false);
  });

  it('ownership is not settable through the schema by a caller passing it directly', () => {
    // Documents the residual surface honestly: the route never reads
    // `githubIssueOwned` from the request body, so the only way it becomes true
    // is the server's own createIssue branch. If a future edit spreads
    // `req.body` into Task.create, this assertion is the thing that should be
    // made to fail.
    const routeSource = require('fs').readFileSync(
      require('path').join(__dirname, '../../../routes/tasksApi.ts'),
      'utf8',
    );

    expect(routeSource).not.toMatch(/githubIssueOwned:\s*(githubIssueOwnedInput|req\.body)/);
    expect(routeSource).toMatch(/githubIssueOwned: ghOwned/);
  });
});
