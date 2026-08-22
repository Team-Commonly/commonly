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

  it('does not give the task route a GitHub write path', () => {
    const routeSource = fs.readFileSync(
      path.join(__dirname, '../../../routes/tasksApi.ts'),
      'utf8',
    );

    expect(routeSource).not.toMatch(/GitHubAppService|githubIssue|createGithubIssue/);
  });
});
