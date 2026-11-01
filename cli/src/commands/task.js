/**
 * commonly task <subcommand>
 *
 * list   — the pod's board, optionally narrowed by status, or to rows this identity holds
 * create — a new row; --notes is a second request, because create does not take notes
 * claim  — take the lease on a row
 * update — change a row's fields, and/or append a history note
 * close  — mark a row done, as its creator or its holder
 *
 * Identity and base URL come from ../lib/task.js. Every subcommand goes through
 * connect() below, so none can grow its own fallback to the saved login. Flags are
 * checked before the first request, so a refusal costs no network round trip.
 */

import { TOKEN_FILE_ENV } from '../lib/inbox.js';
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TOKEN_ENV,
  TaskRefusal,
  UPDATE_STATUSES,
  checkPriority,
  checkStatusFilter,
  checkTaskId,
  checkUpdateStatus,
  createTaskClient,
  describeFailure,
  formatTaskLine,
  requireText,
  resolveTaskBaseUrl,
  resolveTaskToken,
  taskPath,
} from '../lib/task.js';

export const TASK_TOKEN_HELP = `Agent token file (or ${TOKEN_FILE_ENV}, or ${TASK_TOKEN_ENV})`;

const connect = (opts, env, fetchImpl) => createTaskClient({
  baseUrl: resolveTaskBaseUrl(opts, env),
  token: resolveTaskToken(opts, env),
  fetchImpl,
});

const podOf = (opts) => requireText(opts.pod, '--pod');

const report = (err, error) => {
  error(err instanceof TaskRefusal ? `refusing: ${err.message}` : describeFailure(err));
  return 1;
};

// A row goes out as JSON for agents, and as the line a person scans otherwise.
const emitRow = (opts, log, task) => {
  log(opts.json ? JSON.stringify(task, null, 2) : formatTaskLine(task));
};

export const runTaskList = async (opts = {}, deps = {}) => {
  const {
    env = process.env, fetchImpl = fetch, log = console.log, error = console.error,
  } = deps;
  try {
    const pod = podOf(opts);
    const status = opts.status === undefined ? undefined : checkStatusFilter(opts.status);
    const { tasks } = await connect(opts, env, fetchImpl).get(taskPath(pod), { status });
    // The server marks each row claimedByMe for this identity, so --mine needs no second request.
    const rows = opts.mine ? tasks.filter((task) => task.claimedByMe) : tasks;
    if (opts.json) {
      log(JSON.stringify(rows, null, 2));
    } else if (rows.length === 0) {
      log('(no tasks match)');
    } else {
      for (const task of rows) log(formatTaskLine(task));
    }
    return 0;
  } catch (err) {
    return report(err, error);
  }
};

export const runTaskCreate = async (opts = {}, deps = {}) => {
  const {
    env = process.env, fetchImpl = fetch, log = console.log, error = console.error,
  } = deps;
  try {
    const pod = podOf(opts);
    const body = { title: requireText(opts.title, '--title') };
    if (opts.priority !== undefined) body.priority = checkPriority(opts.priority);
    if (opts.assignee !== undefined) body.assignee = requireText(opts.assignee, '--assignee');
    if (opts.dep !== undefined) body.dep = checkTaskId(opts.dep);
    const notes = opts.notes === undefined ? undefined : requireText(opts.notes, '--notes');
    const client = connect(opts, env, fetchImpl);
    const { task } = await client.post(taskPath(pod), body);
    if (notes === undefined) {
      emitRow(opts, log, task);
      return 0;
    }
    // The row exists once the create returns. If the notes fail, say so, so nobody
    // retries the create and makes a twin.
    try {
      const { task: noted } = await client.patch(taskPath(pod, task.taskId), { notes });
      emitRow(opts, log, noted);
      return 0;
    } catch (err) {
      error(`Created ${task.taskId}, but --notes did not save. ${describeFailure(err)}`);
      return 1;
    }
  } catch (err) {
    return report(err, error);
  }
};

export const runTaskClaim = async (taskArg, opts = {}, deps = {}) => {
  const {
    env = process.env, fetchImpl = fetch, log = console.log, error = console.error,
  } = deps;
  try {
    const pod = podOf(opts);
    const taskId = checkTaskId(taskArg);
    const body = opts.continueAnyway ? { continueAnyway: true } : {};
    const { task } = await connect(opts, env, fetchImpl).post(`${taskPath(pod, taskId)}/claim`, body);
    emitRow(opts, log, task);
    return 0;
  } catch (err) {
    return report(err, error);
  }
};

export const runTaskUpdate = async (taskArg, opts = {}, deps = {}) => {
  const {
    env = process.env, fetchImpl = fetch, log = console.log, error = console.error,
  } = deps;
  try {
    const pod = podOf(opts);
    const taskId = checkTaskId(taskArg);
    const fields = {};
    if (opts.status !== undefined) fields.status = checkUpdateStatus(opts.status);
    // An empty value unassigns. The server stores that as null, not as '', so the row
    // reads as unassigned to the router.
    if (opts.assignee !== undefined) fields.assignee = String(opts.assignee).trim();
    if (opts.title !== undefined) fields.title = requireText(opts.title, '--title');
    if (opts.priority !== undefined) fields.priority = checkPriority(opts.priority);
    // "none" clears the dependency. Sending '' would store a dependency that names nothing.
    if (opts.dep !== undefined) fields.dep = opts.dep === 'none' ? null : checkTaskId(opts.dep);
    const note = opts.note === undefined ? undefined : requireText(opts.note, '--note');
    if (Object.keys(fields).length === 0 && note === undefined) {
      throw new TaskRefusal('nothing to change. Pass --status, --assignee, --title, --priority, --dep or --note.');
    }
    const client = connect(opts, env, fetchImpl);
    const path = taskPath(pod, taskId);
    let task = null;
    if (Object.keys(fields).length > 0) ({ task } = await client.patch(path, fields));
    if (note !== undefined) {
      try {
        const body = opts.continueAnyway ? { text: note, continueAnyway: true } : { text: note };
        ({ task } = await client.post(`${path}/updates`, body));
      } catch (err) {
        // With no field change before it, a failed note is the whole failure.
        if (task === null) throw err;
        error(`Updated ${taskId}, but --note did not post. ${describeFailure(err)}`);
        return 1;
      }
    }
    emitRow(opts, log, task);
    return 0;
  } catch (err) {
    return report(err, error);
  }
};

export const runTaskClose = async (taskArg, opts = {}, deps = {}) => {
  const {
    env = process.env, fetchImpl = fetch, log = console.log, error = console.error,
  } = deps;
  try {
    const pod = podOf(opts);
    const taskId = checkTaskId(taskArg);
    const prUrl = opts.pr === undefined ? undefined : requireText(opts.pr, '--pr');
    // No notes key here. /complete replaces the row's notes whenever one is sent.
    const body = prUrl === undefined ? {} : { prUrl };
    const { task } = await connect(opts, env, fetchImpl).post(`${taskPath(pod, taskId)}/complete`, body);
    emitRow(opts, log, task);
    return 0;
  } catch (err) {
    return report(err, error);
  }
};

export const registerTask = (program) => {
  const task = program
    .command('task')
    .description('Read and write the task board as an agent (list, create, claim, update, close)');

  task.addHelpText('after', `
The board is read and written as the identity in a token file, and nowhere else:

  $ commonly task list --pod <podId> --token-file <path>
  $ COMMONLY_AGENT_TOKEN=<token> commonly task claim TASK-123 --pod <podId>

The identity is --token-file, then COMMONLY_TOKEN_FILE, then COMMONLY_AGENT_TOKEN.
The saved login and COMMONLY_TOKEN are never read: a write made under an
operator's login lands on the row under that operator's name.

Each verb does what it says. \`claim\` takes the lease. \`close\` stamps the
completion time and the PR. \`update --status\` sets only pending or blocked, so it
cannot claim or close a row. \`update --note\` appends a history line. The row's
notes are set by \`create --notes\` and are not editable here.

A claim or a note can refuse with unseen messages in the pod. Read them and retry,
or pass --continue-anyway to go ahead without reading them.

Examples:
  $ commonly task list --pod <podId> --status pending,claimed
  $ commonly task list --pod <podId> --mine --json
  $ commonly task create --pod <podId> --title "Fix the board" --priority P1 --notes "Repro in staging"
  $ commonly task claim TASK-123 --pod <podId>
  $ commonly task update TASK-123 --pod <podId> --note "PR is up"
  $ commonly task close TASK-123 --pod <podId> --pr https://github.com/Team-Commonly/commonly/pull/<n>
`);

  task
    .command('list')
    .description("List a pod's task board")
    .requiredOption('--pod <podId>', 'Pod whose board to read')
    .option('--status <list>', `Only these statuses, comma-separated (${TASK_STATUSES.join('|')})`)
    .option('--mine', 'Only rows this identity holds a claim on')
    .option('--token-file <path>', TASK_TOKEN_HELP)
    .option('--instance <url>', 'Target Commonly instance')
    .option('--json', 'Emit the rows as JSON')
    .action(async (opts) => { process.exit(await runTaskList(opts)); });

  task
    .command('create')
    .description('Create a row, then set its --notes (create does not take notes)')
    .requiredOption('--pod <podId>', 'Pod to create the row in')
    .requiredOption('--title <text>', 'Row title')
    .option('--notes <text>', 'Notes to set once the row exists')
    .option('--priority <P>', `${TASK_PRIORITIES.join('|')} (default P2)`)
    .option('--assignee <name>', 'Assign the row at creation')
    .option('--dep <TASK-n>', 'Row this one waits on')
    .option('--token-file <path>', TASK_TOKEN_HELP)
    .option('--instance <url>', 'Target Commonly instance')
    .option('--json', 'Emit the row as JSON')
    .action(async (opts) => { process.exit(await runTaskCreate(opts)); });

  task
    .command('claim <taskId>')
    .description('Take the lease on a row (TASK-n)')
    .requiredOption('--pod <podId>', 'Pod the row is in')
    .option('--continue-anyway', 'Claim even with unseen messages in the pod')
    .option('--token-file <path>', TASK_TOKEN_HELP)
    .option('--instance <url>', 'Target Commonly instance')
    .option('--json', 'Emit the row as JSON')
    .action(async (taskId, opts) => { process.exit(await runTaskClaim(taskId, opts)); });

  task
    .command('update <taskId>')
    .description("Change a row's fields, and/or append a history note")
    .requiredOption('--pod <podId>', 'Pod the row is in')
    .option('--status <status>', `${UPDATE_STATUSES.join('|')} (claim and close have their own commands)`)
    .option('--assignee <name>', 'Reassign the row; an empty value unassigns it')
    .option('--title <text>', 'New title')
    .option('--priority <P>', TASK_PRIORITIES.join('|'))
    .option('--dep <TASK-n>', 'Row this one waits on; "none" clears it')
    .option('--note <text>', 'Append a history note')
    .option('--continue-anyway', 'Post the note even with unseen messages in the pod')
    .option('--token-file <path>', TASK_TOKEN_HELP)
    .option('--instance <url>', 'Target Commonly instance')
    .option('--json', 'Emit the row as JSON')
    .action(async (taskId, opts) => { process.exit(await runTaskUpdate(taskId, opts)); });

  task
    .command('close <taskId>')
    .description('Mark a row done, as its creator or its holder')
    .requiredOption('--pod <podId>', 'Pod the row is in')
    .option('--pr <url>', 'Pull request that delivered the row')
    .option('--token-file <path>', TASK_TOKEN_HELP)
    .option('--instance <url>', 'Target Commonly instance')
    .option('--json', 'Emit the row as JSON')
    .action(async (taskId, opts) => { process.exit(await runTaskClose(taskId, opts)); });
};
