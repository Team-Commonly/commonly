/**
 * commonly inbox <subcommand>
 *
 * list   — read ONE account's own attention queue, newest first, optionally only what is new
 * ack    — acknowledge an item (takes the item's `attentionItemId`)
 * choose — rule a decision card (takes the item's SOURCE id, i.e. the decision id)
 *
 * The account comes from `--token-file <path>` (or COMMONLY_TOKEN_FILE) and from
 * nowhere else — see the header of ../lib/inbox.js for why that is a rule and
 * not a preference. Every run prints the resolved account on its first line.
 */

import { resolveInstanceUrl } from '../lib/config.js';
import {
  InboxRefusal,
  createInboxRequest,
  countsLine,
  fetchQueue,
  filterItems,
  formatAccountLine,
  formatItemLine,
  nextCursorFrom,
  parseCursor,
  parseWindowMs,
  readCursorFile,
  readInboxToken,
  resolveAccountLabel,
  resolveTokenFilePath,
  writeCursorFile,
  INBOX_KINDS,
  TOKEN_FILE_ENV,
} from '../lib/inbox.js';

export const INBOX_TOKEN_HELP = `Account token file (or ${TOKEN_FILE_ENV})`;

const normalizeKind = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const kind = String(value).trim().toLowerCase();
  if (!INBOX_KINDS.includes(kind)) {
    throw new InboxRefusal(`Unknown --kind ${value}. One of: ${INBOX_KINDS.join(', ')}.`);
  }
  return kind;
};

/**
 * Resolve identity and build the request layer. Deliberately the only path to a
 * request: every subcommand goes through it, so no subcommand can grow its own
 * fallback to the saved login.
 */
const connect = async (opts, { env, fetchImpl, sleep }) => {
  const tokenFile = resolveTokenFilePath(opts, env);
  if (!tokenFile) {
    throw new InboxRefusal(
      `no token file. Pass --token-file <path> or set ${TOKEN_FILE_ENV}.\n`
      + 'This command reads ONE account\'s own queue; it never falls back to the saved login, because on a\n'
      + 'shared operator host that login belongs to someone else (Sam\'s queue is the wrong queue, silently).',
    );
  }
  const token = readInboxToken(tokenFile);
  const baseUrl = resolveInstanceUrl(opts.instance);
  const request = createInboxRequest({
    baseUrl, token, tokenFile, fetchImpl, sleep,
  });
  const user = await request('/api/auth/user');
  return {
    tokenFile, baseUrl, request, user, account: resolveAccountLabel(user),
  };
};

const reportRefusal = (err, error) => {
  error(`refusing: ${err.message}`);
  return 1;
};

const reportFailure = (err, error) => {
  error(`Failed: ${err.message}`);
  return 1;
};

export const runInboxList = async (opts = {}, deps = {}) => {
  const {
    env = process.env, fetchImpl = fetch, log = console.log, error = console.error, sleep = undefined,
  } = deps;
  try {
    // Validated before the request: a typo in --kind must not cost a network
    // round trip, and must not read a queue the caller did not ask for.
    const kind = normalizeKind(opts.kind);
    // Validated here with --kind, for the same reason: a typo must not cost a
    // request, and a caller who asked for a window must not silently get another.
    const windowMs = parseWindowMs(opts.window);
    // Read and check the cursor BEFORE connecting: this is a local-file fact, and
    // a misuse of the flags must not cost even the identity request that
    // resolves the account.
    const sinceRaw = opts.since !== undefined ? opts.since : readCursorFile(opts.cursorFile);
    const cursorIn = parseCursor(sinceRaw);
    // A resume cursor is valid only for the query that wrote it. Reading a
    // kind-scoped cursor with a different filter — including no filter at all —
    // would advance past items of other kinds that the earlier read never
    // printed, and no later read could reach them. Only this direction is
    // refused: a BROAD cursor read by a narrower query loses nothing, because
    // that earlier read printed every kind.
    if (cursorIn?.kind && cursorIn.kind !== kind) {
      throw new InboxRefusal(
        `the cursor file was written by a read with --kind ${cursorIn.kind}, and this read is `
        + `${kind ? `--kind ${kind}` : 'not filtered by kind'}. A cursor records how far THAT query got, so this `
        + `read would skip items of other kinds that one never printed. Keep one cursor file per kind, e.g. `
        + `--kind ${cursorIn.kind} --cursor-file <path>.${cursorIn.kind}.`,
      );
    }
    // The window: W behind the cursor's own stamp, not at it. A row stamped before
    // the cursor can commit after the read that wrote it, and it is that read's
    // `since` — not the row — that made it invisible; a read starting W earlier
    // sees it. The ids already delivered inside the window are what keep the
    // re-read from printing the old rows again (see lib/inbox.js).
    const sinceMs = cursorIn ? cursorIn.ms - windowMs : null;
    const since = sinceMs === null ? null : new Date(sinceMs).toISOString();

    const {
      baseUrl, request, account,
    } = await connect(opts, { env, fetchImpl, sleep });

    const { items, meta } = await fetchQueue(request, { podId: opts.pod, since });
    const selected = filterItems(items, {
      kind,
      sinceMs,
      // Everything already delivered inside the window. An item of the same id in
      // the response is a re-delivery, not news; an item that merely shares its
      // instant with one is news, which is why this dedupes by id and not by time.
      seenIds: cursorIn ? cursorIn.ids : [],
    });
    const cursor = nextCursorFrom(selected, cursorIn, kind, windowMs);

    if (opts.json) {
      log(JSON.stringify({
        account,
        instance: baseUrl,
        count: selected.length,
        // The bare timestamp: a caller feeding this back through --since loses
        // the boundary ids, which degrades to re-printing that millisecond
        // rather than to skipping it.
        cursor: cursor ? cursor.at : null,
        countsByKind: meta?.countsByKind || {},
        items: selected,
      }, null, 2));
    } else {
      log(formatAccountLine({ account, baseUrl }));
      const counts = countsLine(meta?.countsByKind);
      log(`open: ${Number.isInteger(meta?.count) ? meta.count : items.length}${counts ? ` (${counts})` : ''}`);
      if (selected.length === 0) {
        log(since ? `(nothing new; the window since ${since} was re-read)` : '(queue is empty)');
      }
      for (const item of selected) log(formatItemLine(item));
      log(`cursor: ${cursor ? cursor.at : ''}`);
    }
    writeCursorFile(opts.cursorFile, cursor);
    return 0;
  } catch (err) {
    if (err instanceof InboxRefusal) return reportRefusal(err, error);
    return reportFailure(err, error);
  }
};

export const runInboxAck = async (itemId, opts = {}, deps = {}) => {
  const {
    env = process.env, fetchImpl = fetch, log = console.log, error = console.error, sleep = undefined,
  } = deps;
  try {
    if (!itemId) throw new InboxRefusal('an item id is required: commonly inbox ack <attentionItemId>');
    const {
      baseUrl, request, account,
    } = await connect(opts, { env, fetchImpl, sleep });
    log(formatAccountLine({ account, baseUrl }));
    const result = await request(`/api/activity/${encodeURIComponent(itemId)}/acknowledge`, {
      method: 'POST',
      body: {},
    });
    log(`acked ${itemId}${result?.success === false ? ` — server said: ${result.error || 'not acknowledged'}` : ''}`);
    return 0;
  } catch (err) {
    if (err instanceof InboxRefusal) return reportRefusal(err, error);
    if (err?.status === 400) {
      error(`Failed: ${err.message}`);
      error('Acknowledge takes the item\'s attentionItemId — the id printed as `item=…` by `commonly inbox list`'
        + ' (the unlabelled source id is what `commonly inbox choose` takes).');
      return 1;
    }
    return reportFailure(err, error);
  }
};

export const runInboxChoose = async (decisionId, value, opts = {}, deps = {}) => {
  const {
    env = process.env, fetchImpl = fetch, log = console.log, error = console.error, sleep = undefined,
  } = deps;
  try {
    if (!decisionId) throw new InboxRefusal('a decision id is required: commonly inbox choose <decisionId> <value>');
    if (value === undefined) throw new InboxRefusal('a value is required: commonly inbox choose <decisionId> <value>');
    const {
      baseUrl, request, account,
    } = await connect(opts, { env, fetchImpl, sleep });
    log(formatAccountLine({ account, baseUrl }));
    const result = await request(`/api/activity/decisions/${encodeURIComponent(decisionId)}/choose`, {
      method: 'POST',
      body: { value },
    });
    log(`chose ${decisionId} = ${value}`);
    log(`-> ${JSON.stringify(result)}`);
    return 0;
  } catch (err) {
    if (err instanceof InboxRefusal) return reportRefusal(err, error);
    return reportFailure(err, error);
  }
};

export const registerInbox = (program) => {
  const inbox = program
    .command('inbox')
    .description("Read and act on ONE account's own attention queue");

  inbox.addHelpText('after', `
The account is read from a token file and from nowhere else:

  $ commonly inbox list --token-file ~/.commonly/bin/connector-ops-token
  $ COMMONLY_TOKEN_FILE=~/.commonly/bin/lily-token commonly inbox list

There is no fallback to the saved login. On a host where \`commonly login\` was
run once as somebody else, a fallback would print that person's queue while the
operator believed they were reading their own. Every run therefore names the
account it resolved on its first line.

With neither --token-file nor COMMONLY_TOKEN_FILE set, the command refuses
before it makes a request.

Examples:
  $ commonly inbox list --json | jq '.items[].title'
  $ commonly inbox list --kind decision --pod <podId>
  $ commonly inbox list --cursor-file ~/.commonly/inbox/connector-ops.cursor   # only what is new
  $ commonly inbox list --cursor-file ~/.commonly/inbox/c.cursor --window 300  # widen the re-read to 5m
  $ commonly inbox ack <attentionItemId>
  $ commonly inbox choose <decisionId> 2

Cost: with no cursor, \`list\` reads the WHOLE queue, one request per 50 items —
550 open items is 11 requests. /api/activity is limited to 60 a minute **keyed on
the caller's IP**, so every session on one host (and the operator's browser)
shares that budget; a 429 is backed off and retried twice on the server's own
\`Retry-After\`, then reported.

With \`--cursor-file\`, the read instead asks for \`createdAt >= cursor - W\`
(\`--window\`, default 60s), so a watcher tick is ONE request. W is the margin
over write-commit latency plus the writer's clock offset — a row is stamped before
its write commits, so resuming exactly at the cursor would lose it. Rows already
delivered inside W are dropped by id, which is the re-delivery the window is for.
The counts printed in the header still describe the whole open set; only the rows
inside the window are printed.

\`ack\` deliberately ships WITHOUT an \`--all\`: a burst of acks shares that same
per-IP budget, so a paced loop is the caller's decision and a bulk
\`ids[]\`-accepting route (one request) is the kernel-side answer.

Ids: \`list\` prints both ids an item has. \`ack\` takes \`item=…\`
(attentionItemId); \`choose\` takes the item's source id, which for a decision is
the decision id. Agent runtime tokens (cm_agent_…) are out of scope — they get
their attention as runtime events, not from this queue.
`);

  inbox
    .command('list')
    .description("List the account's open attention queue, newest first")
    .option('--token-file <path>', INBOX_TOKEN_HELP)
    .option('--since <cursor>', 'ISO-8601 timestamp; only items created after it')
    .option('--cursor-file <path>', 'Read the cursor from this file and write the advanced cursor back')
    .option('--window <seconds>', 'Re-read this far behind the cursor, dropping ids already delivered (default 60; 0 = exact cursor)')
    .option('--kind <kind>', `Only this kind: ${INBOX_KINDS.join('|')}`)
    .option('--pod <podId>', 'Only this pod')
    .option('--json', 'Emit one JSON object (with the resolved account and the cursor)')
    .option('--instance <url>', 'Target Commonly instance')
    .action(async (opts) => { process.exit(await runInboxList(opts)); });

  inbox
    .command('ack <itemId>')
    .description('Acknowledge an attention item (the item= id from `list`)')
    .option('--token-file <path>', INBOX_TOKEN_HELP)
    .option('--instance <url>', 'Target Commonly instance')
    .action(async (itemId, opts) => { process.exit(await runInboxAck(itemId, opts)); });

  inbox
    .command('choose <decisionId> <value>')
    .description('Rule a decision card (the source= id from `list`)')
    .option('--token-file <path>', INBOX_TOKEN_HELP)
    .option('--instance <url>', 'Target Commonly instance')
    .action(async (decisionId, value, opts) => { process.exit(await runInboxChoose(decisionId, value, opts)); });
};
