import mongoose from 'mongoose';
import publicPages from '../config/publicPages.json';

// First-party usage events (D286, spec draft 2 with CTO's PASS). Every rule is
// the server's: a name, screen, page, ref or prop value outside these lists is
// dropped and never stored, and a 400 never echoes what was sent. No typed
// text, no token, no route path with an id in it ever reaches a row.

type PropSchema = Record<string, readonly string[]>;

// Signed-in events, by name, with the enum each prop may take.
export const UI_EVENTS: Record<string, PropSchema> = {
  'app-open': {},
  'screen-view': {},
  'first-screen-view': {},
  'welcome-start-click': { start: ['hosted', 'byo', 'start-pod', 'ask', 'connect-agent'] },
  'welcome-dismiss': {},
  'composer-focus': {},
  'first-message-sent': {},
  'hosted-install-click': {},
  'hosted-install-result': { result: ['live', 'failed', 'timeout'] },
  'agent-settings-open': {},
  'runtime-model-save': { model: ['haiku', 'other'] },
  'agent-reply-seen': {},
  'reaction-add': { kind: ['up', 'down', 'other'] },
  'retry-click': {},
  'invite-open': {},
  'invite-copy': { via: ['link', 'email'] },
  'invite-accept-click': {},
  'invite-accept-result': { result: ['joined', 'expired', 'error'] },
  'board-open': {},
  'task-open': {},
  'decision-answer': { how: ['option', 'other'] },
  'empty-state-shown': {},
  'stuck-help-click': {},
  'get-started-click': { step: ['connect', 'first-task'] },
  'teammate-card-shown': { where: ['workspace', 'pod'] },
  'teammate-card-click': { where: ['workspace', 'pod'] },
  'teammate-card-dismiss': { where: ['workspace', 'pod'] },
};

// Route templates from the V2App table, without the /v2 mount.
export const SCREENS = new Set([
  '/', '/activity', '/pods/:podId', '/pods/:podId/board', '/pods/:podId/tasks/:taskId/record',
  '/agents', '/agents/byo', '/agents/manage', '/agent/:agentName', '/connect', '/connectors',
  '/settings', '/settings/devices', '/invite/:token', '/register', '/login', '/use-cases/:useCaseId',
  '/chat/:podId',
]);

// Logged-out events. A value, where a name takes one, comes from its enum.
export const PUBLIC_EVENTS: Record<string, readonly string[] | null> = {
  'page-view': null,
  'cta-click': ['hero-start', 'nav-signup', 'guide-inline', 'compare-inline', 'pricing'],
  'register-view': null,
  'auth-choice': ['google', 'github', 'email'],
  'register-error': ['invite-required', 'email-taken', 'oauth-denied', 'other'],
  'invite-page-view': null,
};

const PUBLISHED = new Set<string>(publicPages as string[]);
const APP_PAGES = new Set(['/register', '/login', '/invite/:token']);
export const REF_TAGS = new Set(['x', 'li', 'email', 'reddit', 'hn', 'gh', 'ph', 'docs']);

// Where usage events are opt-in (Cofounder ruling 11-10): the EU, the rest of
// the EEA, and the UK. Cloudflare's XX (unknown) and T1 (Tor) get the same
// treatment, as does a request with no country at all: when we can't tell,
// we ask first.
const OPT_IN_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV',
  'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO', 'GB',
]);

export const MAX_BATCH = 20;
export const MAX_PROPS = 4;
export const DAILY_CAP = 2000;
const EVENT_TTL_SECONDS = 90 * 24 * 3600;
const COUNT_TTL_SECONDS = 396 * 24 * 3600; // 13 months
const DM_KINDS = new Set(['agent-room', 'agent-dm', 'agent-admin']);
const TEAM_KINDS = new Set(['chat', 'team']);

type Headers = { get?: (name: string) => string | undefined; headers?: Record<string, unknown> };
const header = (req: Headers, name: string): string => {
  const value = typeof req.get === 'function' ? req.get(name) : req.headers?.[name];
  return String(value || '').trim();
};

// DNT and GPC switch recording off for everyone, on both endpoints.
export const privacySignal = (req: Headers): boolean => header(req, 'dnt') === '1' || header(req, 'sec-gpc') === '1';

// Accounts carry no country, so the request's CF-IPCountry decides the region.
export const optInRegion = (req: Headers): boolean => {
  const country = header(req, 'cf-ipcountry').toUpperCase();
  return !country || country === 'XX' || country === 'T1' || OPT_IN_COUNTRIES.has(country);
};

// What the Settings switch shows when the person never set it.
export const defaultUsageEvents = (req: Headers): boolean => !optInRegion(req);

export const usageAllowed = (req: Headers, preference: unknown): boolean => {
  if (privacySignal(req)) return false;
  if (preference === true) return true;
  if (preference === false) return false;
  return defaultUsageEvents(req);
};

// Our own accounts are recorded and flagged, so reads can leave them out. The
// lists are deploy config (usernames never go in this repo); admins count too.
// USAGE_INTERNAL_PREFIXES covers accounts made on the fly, like walk and seat
// accounts, by the start of the username (F401).
const configList = (value: string | undefined): string[] => String(value || '').split(',')
  .map((name) => name.trim().toLowerCase()).filter(Boolean);
// A slip like `a` in the prefix list would flag real people internal and drop
// them from every read, so a prefix needs this many characters. The daily
// report (scripts/usage-report.js) applies the same floor.
export const MIN_INTERNAL_PREFIX = 4;
export const internalPrefixes = (value: string | undefined = process.env.USAGE_INTERNAL_PREFIXES): {
  prefixes: string[]; ignored: number;
} => {
  const all = configList(value);
  const prefixes = all.filter((prefix) => prefix.length >= MIN_INTERNAL_PREFIX);
  return { prefixes, ignored: all.length - prefixes.length };
};
// Said once at boot, as a count: the list itself is deploy config.
const { ignored: ignoredAtBoot } = internalPrefixes();
if (ignoredAtBoot > 0) {
  const entries = ignoredAtBoot === 1 ? 'entry' : 'entries';
  console.warn(`[usage-events] ignoring ${ignoredAtBoot} USAGE_INTERNAL_PREFIXES ${entries} `
    + `shorter than ${MIN_INTERNAL_PREFIX} characters`);
}
export const isInternalUser = (user: { username?: string; role?: string }): boolean => {
  if (user.role === 'admin') return true;
  const username = String(user.username || '').toLowerCase();
  if (!username) return false;
  return configList(process.env.USAGE_INTERNAL_USERNAMES).includes(username)
    || internalPrefixes().prefixes.some((prefix) => username.startsWith(prefix));
};

const cleanProps = (schema: PropSchema, props: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!props || typeof props !== 'object' || Array.isArray(props)) return out;
  for (const [key, allowed] of Object.entries(schema)) {
    if (Object.keys(out).length >= MAX_PROPS) break;
    const value = (props as Record<string, unknown>)[key];
    if (typeof value === 'string' && allowed.includes(value)) out[key] = value;
  }
  return out;
};

let indexes: Promise<unknown> | null = null;
const ensureIndexes = (): Promise<unknown> => {
  if (!indexes) {
    const db = mongoose.connection.db;
    indexes = Promise.all([
      db.collection('ui_events').createIndex({ at: 1 }, { expireAfterSeconds: EVENT_TTL_SECONDS }),
      db.collection('ui_events').createIndex({ userId: 1, at: 1 }),
      db.collection('ui_daily_counts').createIndex({ dayStart: 1 }, { expireAfterSeconds: COUNT_TTL_SECONDS }),
    ]).catch((err) => { indexes = null; throw err; });
  }
  return indexes;
};

const utcDayStart = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

export type UiEventCaller = { _id: unknown; username?: string; role?: string };
type PodRow = { _id: unknown; type?: string; members?: unknown[] };
type PodLoader = (podId: string) => Promise<PodRow | null>;
type CanView = (userId: unknown, pod: PodRow) => Promise<boolean>;

// Validates a batch and writes what survives. Returns how many rows were kept.
// Throws nothing for bad input: the route decides the 400 from `valid`.
export async function recordUiEvents(
  user: UiEventCaller,
  input: unknown[],
  deps: { loadPod: PodLoader; canViewPod: CanView },
): Promise<{ valid: number; stored: number }> {
  const now = new Date();
  const rows: Record<string, unknown>[] = [];
  const pods = new Map<string, Promise<{ podKind?: string; keepId: boolean }>>();
  const podFacts = (podId: string) => {
    if (!pods.has(podId)) {
      pods.set(podId, (async () => {
        const pod = await deps.loadPod(podId);
        if (!pod || !(await deps.canViewPod(user._id, pod))) return { keepId: false };
        const podKind = String(pod.type || 'chat');
        // canViewPod admits global admins to any pod; the id stays only for a member.
        const member = (pod.members || []).some((m) => String((m as { _id?: unknown })?._id || m) === String(user._id));
        return { podKind, keepId: member && TEAM_KINDS.has(podKind) };
      })().catch(() => ({ keepId: false })));
    }
    return pods.get(podId)!;
  };

  for (const raw of input.slice(0, MAX_BATCH)) {
    if (!raw || typeof raw !== 'object') continue;
    const event = raw as Record<string, unknown>;
    const name = typeof event.name === 'string' ? event.name : '';
    const schema = Object.prototype.hasOwnProperty.call(UI_EVENTS, name) ? UI_EVENTS[name] : null;
    if (!schema) continue;
    const screen = typeof event.screen === 'string' && SCREENS.has(event.screen) ? event.screen : 'other';
    const row: Record<string, unknown> = { userId: user._id, name, screen, isInternal: isInternalUser(user), at: now };
    let props = cleanProps(schema, event.props);
    const podId = typeof event.podId === 'string' && mongoose.Types.ObjectId.isValid(event.podId) ? event.podId : null;
    if (podId) {
      // eslint-disable-next-line no-await-in-loop
      const facts = await podFacts(podId);
      if (facts.podKind) row.podKind = facts.podKind;
      if (facts.keepId) row.podId = new mongoose.Types.ObjectId(podId);
      // Inside a DM with an agent, the row is the event's name, screen and kind.
      if (facts.podKind && DM_KINDS.has(facts.podKind)) props = {};
    }
    if (Object.keys(props).length) row.props = props;
    rows.push(row);
  }
  if (!rows.length) return { valid: 0, stored: 0 };

  await ensureIndexes();
  const collection = mongoose.connection.db.collection('ui_events');
  const today = await collection.countDocuments({ userId: user._id, at: { $gte: utcDayStart(now) } });
  const room = Math.max(0, DAILY_CAP - today);
  const kept = rows.slice(0, room);
  if (kept.length) await collection.insertMany(kept, { ordered: false });
  return { valid: rows.length, stored: kept.length };
}

// The page a logged-out hit counts against: a published page by its path, an
// app page by its template, anything else as "other".
export const publicPage = (page: unknown): string => {
  if (typeof page !== 'string') return 'other';
  if (APP_PAGES.has(page)) return page;
  if (/^\/invite\/[^/]+\/?$/.test(page)) return '/invite/:token';
  const path = page.endsWith('/') ? page : `${page}/`;
  if (PUBLISHED.has(page)) return page;
  if (PUBLISHED.has(path)) return path;
  return 'other';
};

// One counter per day, name, page, ref and value. Nothing about the visitor.
export async function countPublicHit(input: Record<string, unknown>): Promise<boolean> {
  const name = typeof input.name === 'string' ? input.name : '';
  if (!Object.prototype.hasOwnProperty.call(PUBLIC_EVENTS, name)) return false;
  const values = PUBLIC_EVENTS[name];
  const value = values && typeof input.value === 'string' && values.includes(input.value) ? input.value : null;
  const page = name === 'invite-page-view' ? '/invite/:token' : publicPage(input.page);
  const refTag = typeof input.ref === 'string' && input.ref
    ? (REF_TAGS.has(input.ref.toLowerCase()) ? input.ref.toLowerCase() : 'other')
    : 'none';
  const dayStart = utcDayStart(new Date());
  const day = dayStart.toISOString().slice(0, 10);
  await ensureIndexes();
  await mongoose.connection.db.collection('ui_daily_counts').updateOne(
    { _id: `${day}|${name}|${page}|${refTag}|${value || ''}` } as any,
    { $setOnInsert: { day, dayStart, name, page, refTag, ...(value ? { value } : {}) }, $inc: { n: 1 } },
    { upsert: true },
  );
  return true;
}

// Account deletion removes the person's rows at once (CTO 6).
export async function deleteUiEventsFor(userId: string): Promise<void> {
  const ids: unknown[] = [userId];
  if (mongoose.Types.ObjectId.isValid(userId)) ids.push(new mongoose.Types.ObjectId(userId));
  await mongoose.connection.db.collection('ui_events').deleteMany({ userId: { $in: ids } });
}
