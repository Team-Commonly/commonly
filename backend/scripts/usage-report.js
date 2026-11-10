// F403 (D286): the daily usage read Growth runs on ops-runner. Read-only and
// aggregate-only: per-day counts by event and by screen or step from
// `ui_events` (signed in), and per-day hits by page from `ui_daily_counts`
// (logged out). Our own accounts are left out: the stored isInternal stamp,
// admins, USAGE_INTERNAL_USERNAMES and USAGE_INTERNAL_PREFIXES, re-applied at
// read time so rows stamped before a name was listed still drop. Nothing it
// returns or prints carries an id, a username or typed text.
//
// Run (docs/development/usage-events.md):
//   growth-prod-read.sh backend/scripts/usage-report.js DAYS=14
// DAYS is 1-90 (default 7); FORMAT=json prints JSON instead of the table.

const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;
// A slip like `a` in the prefix list would flag real people internal and drop
// them from every read, so a prefix needs at least this many characters.
const MIN_PREFIX = 4;
const DAY_MS = 24 * 3600 * 1000;

const configList = (value) => String(value || '').split(',')
  .map((entry) => entry.trim().toLowerCase()).filter(Boolean);
const utcDay = (date) => date.toISOString().slice(0, 10);

const windowDays = (value) => {
  const n = Number(value);
  if (value === undefined || value === '' || !Number.isFinite(n)) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.max(1, Math.floor(n)));
};

// Props hold enum values only (UI_EVENTS), so they read as a step: `start=byo`.
const stepOf = (props) => Object.keys(props || {}).sort().map((key) => `${key}=${props[key]}`).join(',');

async function buildUsageReport(db, opts = {}) {
  const days = windowDays(opts.days);
  const now = opts.now || new Date();
  const until = new Date(Date.parse(utcDay(now)) + DAY_MS);
  const since = new Date(until.getTime() - days * DAY_MS);
  const usernames = configList(opts.usernames);
  const allPrefixes = configList(opts.prefixes);
  const prefixes = allPrefixes.filter((prefix) => prefix.length >= MIN_PREFIX);

  // Who is ours, decided here from a narrow read rather than with newer
  // aggregation operators, so the read runs on whatever Mongo the instance has.
  const inWindow = { at: { $gte: since, $lt: until } };
  // The writer stores ObjectIds; a string id is matched too, as deleteUiEventsFor does,
  // by the account id's string form (no ObjectId built here, so no second bson copy).
  const userIds = await db.collection('ui_events').distinct('userId', inWindow);
  const stringIds = userIds.filter((id) => typeof id === 'string');
  const idMatch = stringIds.length
    ? { $or: [{ _id: { $in: userIds } }, { $expr: { $in: [{ $toString: '$_id' }, stringIds] } }] }
    : { _id: { $in: userIds } };
  const accounts = userIds.length
    ? await db.collection('users').find(idMatch).project({ username: 1, role: 1 }).toArray()
    : [];
  const ours = accounts.filter((account) => {
    const username = String(account.username || '').toLowerCase();
    return account.role === 'admin' || usernames.includes(username)
      || (Boolean(username) && prefixes.some((prefix) => username.startsWith(prefix)));
  }).flatMap((account) => [account._id, String(account._id)]);
  const kept = { ...inWindow, isInternal: { $ne: true }, userId: { $nin: ours } };
  const dayOf = { $dateToString: { format: '%Y-%m-%d', date: '$at' } };

  const [excludedInternalEvents, rows, active] = await Promise.all([
    db.collection('ui_events').countDocuments({ ...inWindow, $or: [{ isInternal: true }, { userId: { $in: ours } }] }),
    db.collection('ui_events').aggregate([
      { $match: kept },
      { $group: {
        _id: { day: dayOf, name: '$name', screen: '$screen', props: '$props' },
        events: { $sum: 1 },
        people: { $addToSet: '$userId' },
      } },
      { $project: { _id: 0, key: '$_id', events: 1, people: { $size: '$people' } } },
    ], { allowDiskUse: true }).toArray(),
    db.collection('ui_events').aggregate([
      { $match: kept },
      { $group: { _id: dayOf, people: { $addToSet: '$userId' } } },
      { $project: { _id: 0, day: '$_id', people: { $size: '$people' } } },
    ], { allowDiskUse: true }).toArray(),
  ]);

  const signedIn = rows.map(({ key, events: n, people }) => ({
    day: key.day, name: key.name, screen: key.screen || '', step: stepOf(key.props), events: n, people,
  })).sort((a, b) => b.day.localeCompare(a.day) || a.name.localeCompare(b.name)
    || a.screen.localeCompare(b.screen) || a.step.localeCompare(b.step));

  const counts = await db.collection('ui_daily_counts')
    .find({ day: { $gte: utcDay(since), $lt: utcDay(until) } })
    .project({ _id: 0, day: 1, name: 1, page: 1, refTag: 1, value: 1, n: 1 })
    .toArray();
  const loggedOut = counts.map((row) => ({
    day: row.day, name: row.name, page: row.page, ref: row.refTag || 'none', value: row.value || '', hits: row.n,
  })).sort((a, b) => b.day.localeCompare(a.day) || a.name.localeCompare(b.name)
    || a.page.localeCompare(b.page) || a.ref.localeCompare(b.ref) || a.value.localeCompare(b.value));

  return {
    days,
    from: utcDay(since),
    to: utcDay(new Date(until.getTime() - DAY_MS)),
    excludedInternalEvents,
    ignoredShortPrefixes: allPrefixes.length - prefixes.length,
    activePeople: active.sort((a, b) => b.day.localeCompare(a.day)),
    signedIn,
    loggedOut,
  };
}

const table = (rows, columns) => {
  if (!rows.length) return '  (none)\n';
  const widths = columns.map((col) => Math.max(col.length, ...rows.map((row) => String(row[col]).length)));
  const line = (cells) => `  ${cells.map((cell, i) => String(cell).padEnd(widths[i])).join('  ')}`.trimEnd();
  return `${[line(columns), ...rows.map((row) => line(columns.map((col) => row[col])))].join('\n')}\n`;
};

function formatUsageReport(report) {
  return [
    `Usage ${report.from} to ${report.to} (UTC, ${report.days} days). Our own accounts left out: ${report.excludedInternalEvents} events.\n`,
    report.ignoredShortPrefixes ? `Ignored ${report.ignoredShortPrefixes} internal prefix(es) shorter than ${MIN_PREFIX} characters.\n` : '',
    '\nPeople active per day (signed in)\n',
    table(report.activePeople, ['day', 'people']),
    '\nSigned-in events per day, by event and screen or step\n',
    table(report.signedIn, ['day', 'name', 'screen', 'step', 'events', 'people']),
    '\nLogged-out hits per day, by page\n',
    table(report.loggedOut, ['day', 'name', 'page', 'ref', 'value', 'hits']),
  ].filter(Boolean).join('');
}

async function main() {
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const report = await buildUsageReport(client.db(), {
      days: process.env.DAYS,
      usernames: process.env.USAGE_INTERNAL_USERNAMES,
      prefixes: process.env.USAGE_INTERNAL_PREFIXES,
    });
    process.stdout.write(process.env.FORMAT === 'json' ? `${JSON.stringify(report)}\n` : formatUsageReport(report));
  } finally {
    await client.close();
  }
}

module.exports = { buildUsageReport, formatUsageReport, MIN_PREFIX };

// Runs when executed, including as `node -` on stdin (module.id '[stdin]'), the way growth-prod-read.sh sends it.
if (require.main === module || module.id === '[stdin]') {
  // The error's name and code only: a message can echo the query or name hosts.
  main().catch((err) => { console.error('usage report failed:', err.name, err.code || ''); process.exit(1); });
}
