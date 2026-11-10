import { matchPath } from 'react-router-dom';
import getApiBaseUrl from '../../utils/apiBaseUrl';

// First-party usage events (D286). Fixed names, route templates and enum
// props only: never typed text, a message, a token, or a path with an id in
// it. The server holds the same allowlists and drops anything outside them;
// this side only avoids sending what would be dropped anyway.

export type UsageEventName =
  | 'app-open' | 'screen-view' | 'first-screen-view' | 'welcome-start-click' | 'welcome-dismiss'
  | 'composer-focus' | 'first-message-sent' | 'hosted-install-click' | 'hosted-install-result'
  | 'agent-settings-open' | 'runtime-model-save' | 'agent-reply-seen' | 'reaction-add' | 'retry-click'
  | 'invite-open' | 'invite-copy' | 'invite-accept-click' | 'invite-accept-result'
  | 'board-open' | 'task-open' | 'decision-answer' | 'empty-state-shown' | 'stuck-help-click';

export type PublicEventName =
  | 'page-view' | 'cta-click' | 'register-view' | 'auth-choice' | 'register-error' | 'invite-page-view';

// The V2App route table, without the /v2 mount, most specific first.
const SCREENS = [
  '/pods/:podId/tasks/:taskId/record', '/pods/:podId/board', '/pods/:podId',
  '/agents/byo', '/agents/manage', '/agents', '/agent/:agentName',
  '/settings/devices', '/settings', '/activity', '/connect', '/connectors',
  '/invite/:token', '/register', '/login', '/use-cases/:useCaseId', '/chat/:podId', '/',
];

export const screenTemplate = (pathname: string): string => {
  const path = pathname.replace(/^\/v2(?=\/|$)/, '') || '/';
  for (const pattern of SCREENS) {
    if (matchPath({ path: pattern, end: true }, path)) return pattern;
  }
  return 'other';
};

// The pod a screen is about, for the server to check and classify.
export const screenPodId = (pathname: string): string | undefined => {
  const path = pathname.replace(/^\/v2(?=\/|$)/, '') || '/';
  const match = matchPath({ path: '/pods/:podId/*', end: false }, path) || matchPath({ path: '/chat/:podId', end: true }, path);
  const podId = match?.params?.podId;
  return podId && /^[a-f0-9]{24}$/i.test(podId) ? podId : undefined;
};

const browserSignal = (): boolean => {
  if (typeof navigator === 'undefined') return true;
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  return nav.doNotTrack === '1' || Boolean(nav.globalPrivacyControl)
    || (typeof window !== 'undefined' && (window as Window & { doNotTrack?: string }).doNotTrack === '1');
};

const readToken = (): string | null => {
  try { return localStorage.getItem('token'); } catch { return null; }
};

type QueuedEvent = { name: UsageEventName; screen: string; props?: Record<string, string>; podId?: string };

// null until the Settings value is known; events wait for it, and are dropped
// if it comes back off.
let enabled: boolean | null = null;
let queue: QueuedEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_MS = 2000;
const MAX_BATCH = 20;
const MAX_WAITING = 100;

const flush = (): void => {
  if (timer) { clearTimeout(timer); timer = null; }
  if (enabled !== true || !queue.length) return;
  const token = readToken();
  // Usage events never break a page: no fetch (old browsers, tests) means none are sent.
  if (!token || browserSignal() || typeof fetch !== 'function') { queue = []; return; }
  while (queue.length) {
    const events = queue.splice(0, MAX_BATCH);
    // keepalive with the Bearer header, so a batch survives the page closing.
    // Never sendBeacon: it can't carry the header, and a token never goes in a body.
    void fetch(`${getApiBaseUrl()}/api/stats/ui-event`, {
      method: 'POST',
      keepalive: true,
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ events }),
    }).catch(() => {});
  }
};

const schedule = (): void => {
  if (queue.length >= MAX_BATCH) { flush(); return; }
  if (!timer) timer = setTimeout(flush, FLUSH_MS);
};

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
}

export const setUsageEventsEnabled = (value: boolean): void => {
  enabled = value;
  if (!value) { queue = []; return; }
  schedule();
};

export const trackUsage = (
  name: UsageEventName,
  options: { props?: Record<string, string>; podId?: string; pathname?: string } = {},
): void => {
  if (enabled === false || browserSignal() || !readToken()) return;
  const pathname = options.pathname ?? (typeof window !== 'undefined' ? window.location.pathname : '/');
  const podId = options.podId ?? screenPodId(pathname);
  queue.push({
    name,
    screen: screenTemplate(pathname),
    ...(options.props ? { props: options.props } : {}),
    ...(podId ? { podId } : {}),
  });
  if (queue.length > MAX_WAITING) queue = queue.slice(-MAX_WAITING);
  if (enabled === true) schedule();
};

// Once per page load, for events that answer "did this happen at all".
const sentOnce = new Set<string>();
export const trackUsageOnce = (key: string, name: UsageEventName, options?: Parameters<typeof trackUsage>[1]): void => {
  if (sentOnce.has(key)) return;
  sentOnce.add(key);
  trackUsage(name, options);
};

// Logged-out counts on app pages (/register, /login, /invite/:token). The
// prerendered pages send their own (scripts/generate-seo-pages.mjs). No
// cookie, no stored key, no identifier; only a page template and a campaign
// code the server maps to its own list.
export const trackPublic = (name: PublicEventName, value?: string): void => {
  if (typeof fetch !== 'function' || browserSignal() || readToken() || typeof window === 'undefined') return;
  const page = screenTemplate(window.location.pathname);
  let ref = '';
  try { ref = new URLSearchParams(window.location.search).get('ref') || ''; } catch { ref = ''; }
  void fetch(`${getApiBaseUrl()}/api/stats/public-hit`, {
    method: 'POST',
    keepalive: true,
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, page, ...(ref ? { ref } : {}), ...(value ? { value } : {}) }),
  }).catch(() => {});
};

// Sign-out or an account switch: nothing queued for one person goes out under another's token.
export const forgetUsageEvents = (): void => {
  enabled = null;
  queue = [];
  if (timer) { clearTimeout(timer); timer = null; }
};

/** Test seam: forget queued events, the setting and once-keys. */
export const resetUsageEventsForTest = (): void => {
  enabled = null;
  queue = [];
  sentOnce.clear();
  if (timer) { clearTimeout(timer); timer = null; }
};
