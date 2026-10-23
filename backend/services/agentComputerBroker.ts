/**
 * Staging agent computer. Steel owns one browser profile per person; this
 * broker owns its single live session and gives each native installation a
 * separate tab in that profile. Agents never receive a Steel URL or CDP port.
 */
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright-core';
import { randomUUID } from 'crypto';
import { AgentComputerTakeover } from '../models/AgentComputerTakeover';

type SteelSession = { id: string; status: string };
type SteelSessions = { sessions: SteelSession[] };
type ComputerConfig = {
  apiUrl: (userId: string) => string;
  cdpUrl: (userId: string) => string;
  allowedHosts: ReadonlySet<string>;
};
type Connect = (endpoint: string) => Promise<Browser>;
type TakeoverStore = {
  get: (userId: string, installationId: string) => Promise<boolean>;
  set: (userId: string, installationId: string, active: boolean) => Promise<void>;
  bindings: (userId: string) => Promise<{ installationId: string; targetId: string }[]>;
  bind: (userId: string, installationId: string, targetId: string) => Promise<void>;
};
type UserBrowser = {
  browser: Browser;
  context: BrowserContext;
  tabs: Map<string, Page>;
  takeover: Set<string>;
  frames: Map<string, { bytes: Buffer; revision: string; width: number; height: number }>;
  revisions: Map<string, number>;
  humanActionSeen: Set<string>;
  pendingWrites: Map<string, { route: Route; installationId: string; method: string; url: string; timer: NodeJS.Timeout }>;
  epoch: string;
};

const USER_ID = /^[a-f\d]{24}$/i;
const INSTALLATION_ID = /^[a-f\d]{24}$/i;
const SESSION_TIMEOUT_MS = 20_000;
const ACTION_TIMEOUT_MS = 15_000;
const MAX_SNAPSHOT_CHARS = 18_000;
const MAX_SCREENSHOT_BYTES = 1_000_000;
const WRITE_APPROVAL_TIMEOUT_MS = 30_000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const HUMAN_KEYS = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

const templateUrl = (template: string, userId: string): string => {
  if (!USER_ID.test(userId) || !template.includes('{userId}')) throw new Error('Computer endpoint is not configured.');
  const url = new URL(template.replaceAll('{userId}', userId));
  if (!['http:', 'ws:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Computer endpoint is not configured.');
  }
  return url.toString().replace(/\/$/, '');
};

export const agentComputerEnabled = (): boolean => process.env.AGENT_COMPUTER_ENABLED === 'true'
  && Boolean(process.env.AGENT_COMPUTER_STEEL_API_URL_TEMPLATE)
  && Boolean(process.env.AGENT_COMPUTER_STEEL_CDP_URL_TEMPLATE)
  && Boolean(process.env.AGENT_COMPUTER_WAKER_URL)
  && Boolean(process.env.AGENT_COMPUTER_WAKER_TOKEN);

const configured: ComputerConfig = {
  apiUrl: (userId) => templateUrl(process.env.AGENT_COMPUTER_STEEL_API_URL_TEMPLATE || '', userId),
  cdpUrl: (userId) => templateUrl(process.env.AGENT_COMPUTER_STEEL_CDP_URL_TEMPLATE || '', userId),
  allowedHosts: new Set((process.env.AGENT_COMPUTER_ALLOWED_HOSTS || '')
    .split(',').map((host) => host.trim().toLowerCase()).filter(Boolean)),
};

const steelRequest = async <T>(url: string, method: 'GET' | 'POST'): Promise<T> => {
  const response = await fetch(url, {
    method,
    ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ persist: true }) } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Steel session request failed (${response.status}).`);
  return response.json() as Promise<T>;
};

const wakeSteel = async (userId: string): Promise<void> => {
  if (!USER_ID.test(userId)) throw new Error('A human owner is required for the agent computer.');
  const base = new URL(process.env.AGENT_COMPUTER_WAKER_URL || '');
  if (base.protocol !== 'http:' || base.username || base.password || base.search || base.hash) {
    throw new Error('Computer waker is not configured.');
  }
  const response = await fetch(`${base.toString().replace(/\/$/, '')}/v1/users/${userId}/wake`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.AGENT_COMPUTER_WAKER_TOKEN}` },
    redirect: 'error',
    signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Computer waker failed (${response.status}).`);
};

const takeoverStore: TakeoverStore = {
  get: async (userId, installationId) => Boolean(await AgentComputerTakeover.exists({
    _id: installationId, ownerId: userId, active: true,
  })),
  set: async (userId, installationId, active) => {
    await AgentComputerTakeover.updateOne(
      { _id: installationId, ownerId: userId },
      { $set: { active } },
      { upsert: true },
    );
  },
  bindings: async (userId) => {
    const rows = await AgentComputerTakeover.find({ ownerId: userId, targetId: { $exists: true } })
      .select('_id targetId').lean();
    return rows.flatMap((row) => {
      const targetId = (row as { targetId?: unknown }).targetId;
      return typeof targetId === 'string' && targetId
        ? [{ installationId: String(row._id), targetId }] : [];
    });
  },
  bind: async (userId, installationId, targetId) => {
    await AgentComputerTakeover.updateOne(
      { _id: installationId, ownerId: userId },
      { $set: { targetId }, $setOnInsert: { active: false } },
      { upsert: true },
    );
  },
};

export const isCommitControl = (control: {
  tag: string; type: string; role: string; label: string; text: string;
  formAction: string; inForm?: boolean; title?: string; value?: string; name?: string; testId?: string;
}): boolean => {
  if (control.type === 'submit' || control.formAction
    || (control.tag === 'button' && control.inForm && control.type !== 'button' && control.type !== 'reset')) return true;
  // An arbitrary clickable div may be wired to a send handler; require a
  // semantic control whose action can be inspected.
  if (!['button', 'input', 'a'].includes(control.tag) && control.role !== 'button') return true;
  const caption = `${control.label} ${control.text} ${control.title || ''} ${control.value || ''} `
    + `${control.name || ''} ${control.testId || ''}`;
  if (!caption.trim() && (control.tag === 'button' || control.role === 'button')) return true;
  return /\b(send|submit|post|publish|reply|share|confirm|place order|pay|purchase)\b/i
    .test(caption);
};

export class AgentComputerBroker {
  private users = new Map<string, Promise<UserBrowser>>();
  private pendingTabs = new Map<string, Promise<Page>>();

  // Injection seams let service tests use fake Steel and CDP without a browser.
  // eslint-disable-next-line no-useless-constructor
  constructor(
    private readonly config: ComputerConfig = configured,
    private readonly request: typeof steelRequest = steelRequest,
    private readonly connect: Connect = (endpoint) => chromium.connectOverCDP(endpoint, { timeout: SESSION_TIMEOUT_MS }),
    private readonly wake: (userId: string) => Promise<void> = wakeSteel,
    private readonly takeoverState: TakeoverStore = takeoverStore,
  ) {} // eslint-disable-line no-empty-function

  private async attachPage(page: Page): Promise<void> {
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    // Request interception is installed on the shared context before any tab
    // navigates; Page.route misses the first request of a new popup.
  }

  private async targetId(context: BrowserContext, page: Page): Promise<string> {
    const session = await context.newCDPSession(page);
    try {
      const result = await session.send('Target.getTargetInfo');
      const id = result.targetInfo?.targetId;
      if (typeof id !== 'string' || !id) throw new Error('Computer tab identity is unavailable.');
      return id;
    } finally {
      await session.detach();
    }
  }

  private async guardRequest(route: Route, state: UserBrowser): Promise<void> {
    const request = route.request();
    let page: Page;
    try { page = request.frame().page(); } catch { await route.abort(); return; }
    const installationId = [...state.tabs].find(([, tab]) => tab === page)?.[0];
    // A popup is not an installation tab. Its first request must be denied.
    if (!installationId) { await route.abort(); return; }
    if (request.isNavigationRequest() && !request.frame().parentFrame()) {
      let target: URL;
      try { target = new URL(request.url()); } catch { await route.abort(); return; }
      if (target.protocol !== 'https:' || !this.config.allowedHosts.has(target.hostname.toLowerCase())) {
        await route.abort(); return;
      }
    }
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) { await route.fallback(); return; }
    // A takeover request alone grants no write permission. A request after a
    // human action pauses until the person explicitly approves that request.
    if (!state.takeover.has(installationId) || !state.humanActionSeen.has(installationId)) {
      await route.abort(); return;
    }
    if (state.pendingWrites.size >= 10) { await route.abort(); return; }
    const id = randomUUID();
    const timer = setTimeout(() => {
      const pending = state.pendingWrites.get(id);
      if (pending) {
        state.pendingWrites.delete(id);
        pending.route.abort().catch(() => {});
      }
    }, WRITE_APPROVAL_TIMEOUT_MS);
    state.pendingWrites.set(id, {
      route, installationId, method: request.method(), url: request.url(), timer,
    });
  }

  private async abortPendingWrites(state: UserBrowser, installationId: string): Promise<void> {
    const pending = [...state.pendingWrites].filter(([, write]) => write.installationId === installationId);
    await Promise.all(pending.map(async ([id, write]) => {
      state.pendingWrites.delete(id);
      clearTimeout(write.timer);
      await write.route.abort().catch(() => {});
    }));
  }

  private async openUser(userId: string): Promise<UserBrowser> {
    await this.wake(userId);
    const api = this.config.apiUrl(userId);
    const listed = await this.request<SteelSessions>(`${api}/v1/sessions`, 'GET');
    // Steel reports a newly-created but still-running session as `idle` before
    // it becomes `live`; starting another at that point relaunches the browser.
    const active = listed.sessions.filter((session) => ['idle', 'live'].includes(session.status));
    const unknown = listed.sessions.filter((session) => ![
      'idle', 'live', 'closed', 'expired', 'stopped', 'failed', 'ended', 'released',
    ].includes(session.status));
    if (unknown.length) throw new Error('Steel session state is unknown; refusing to relaunch the browser.');
    if (active.length > 1) throw new Error('Steel has more than one active session for this person.');
    if (active.length === 0) await this.request<SteelSession>(`${api}/v1/sessions`, 'POST');
    const browser = await this.connect(this.config.cdpUrl(userId));
    const context = browser.contexts()[0];
    if (!context) throw new Error('Steel did not expose its persistent browser context.');
    const state: UserBrowser = {
      browser, context, tabs: new Map(), takeover: new Set(), frames: new Map(), revisions: new Map(),
      humanActionSeen: new Set(), pendingWrites: new Map(),
      epoch: randomUUID(),
    };
    await context.route('**/*', (route) => this.guardRequest(route, state));
    const bindings = await this.takeoverState.bindings(userId);
    const byTarget = new Map(bindings.filter(({ installationId }) => INSTALLATION_ID.test(installationId))
      .map(({ installationId, targetId }) => [targetId, installationId]));
    for (const page of context.pages()) {
      let targetId: string;
      try { targetId = await this.targetId(context, page); } catch { continue; }
      const installationId = byTarget.get(targetId);
      if (!installationId) continue;
      if (state.tabs.has(installationId)) throw new Error('Duplicate agent computer tab bindings need operator recovery.');
      if (await this.takeoverState.get(userId, installationId)) state.takeover.add(installationId);
      await this.attachPage(page);
      state.tabs.set(installationId, page);
    }
    return state;
  }

  private user(userId: string): Promise<UserBrowser> {
    if (!USER_ID.test(userId)) throw new Error('A human owner is required for the agent computer.');
    let pending = this.users.get(userId);
    if (!pending) {
      pending = this.openUser(userId);
      this.users.set(userId, pending);
      pending.catch(() => { if (this.users.get(userId) === pending) this.users.delete(userId); });
      pending.then(({ browser }) => browser.on('disconnected', () => {
        if (this.users.get(userId) === pending) this.users.delete(userId);
      })).catch(() => {});
    }
    return pending;
  }

  private async tab(userId: string, installationId: string, allowTakeover = false): Promise<Page> {
    if (!INSTALLATION_ID.test(installationId)) throw new Error('An installation is required for the agent computer.');
    const state = await this.user(userId);
    if (!allowTakeover && state.takeover.has(installationId)) {
      throw new Error('The person has control of this tab. Wait for hand-back.');
    }
    let page = state.tabs.get(installationId);
    if (!page || page.isClosed()) {
      const key = `${userId}:${installationId}`;
      let pending = this.pendingTabs.get(key);
      if (!pending) {
        pending = (async () => {
          state.frames.delete(installationId);
          if (await this.takeoverState.get(userId, installationId)) state.takeover.add(installationId);
          if (!allowTakeover && state.takeover.has(installationId)) {
            throw new Error('The person has control of this tab. Wait for hand-back.');
          }
          const created = await state.context.newPage();
          const targetId = await this.targetId(state.context, created);
          await this.takeoverState.bind(userId, installationId, targetId);
          await this.attachPage(created);
          state.tabs.set(installationId, created);
          return created;
        })();
        this.pendingTabs.set(key, pending);
        pending.finally(() => { if (this.pendingTabs.get(key) === pending) this.pendingTabs.delete(key); }).catch(() => {});
      }
      page = await pending;
    }
    if (!allowTakeover && state.takeover.has(installationId)) {
      throw new Error('The person has control of this tab. Wait for hand-back.');
    }
    return page;
  }

  async navigate(userId: string, installationId: string, rawUrl: string): Promise<{ url: string; title: string }> {
    let url: URL;
    try { url = new URL(rawUrl); } catch { throw new Error('A valid HTTPS address is required.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search
      || !this.config.allowedHosts.has(url.hostname.toLowerCase())) {
      throw new Error('That address is outside this computer trial.');
    }
    const page = await this.tab(userId, installationId);
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: ACTION_TIMEOUT_MS });
    return { url: page.url(), title: await page.title() };
  }

  async snapshot(userId: string, installationId: string): Promise<{ url: string; title: string; text: string }> {
    const page = await this.tab(userId, installationId);
    return {
      url: page.url(), title: await page.title(),
      text: (await page.locator('body').ariaSnapshot()).slice(0, MAX_SNAPSHOT_CHARS),
    };
  }

  async click(userId: string, installationId: string, selector: string): Promise<'clicked' | 'person_required'> {
    const page = await this.tab(userId, installationId);
    const locator = page.locator(selector);
    if (await locator.count() !== 1) throw new Error('The click target must identify exactly one element.');
    const control = await locator.evaluate((element) => {
      const target = element.closest('button, input, a, [role="button"]') || element;
      const html = target as HTMLElement;
      return {
        tag: target.tagName.toLowerCase(),
        type: (target.getAttribute('type') || '').toLowerCase(),
        role: (target.getAttribute('role') || '').toLowerCase(),
        label: target.getAttribute('aria-label') || '',
        text: (html.innerText || target.textContent || '').slice(0, 200),
        formAction: target.getAttribute('formaction') || '',
        inForm: Boolean(target.closest('form')),
        title: target.getAttribute('title') || '',
        value: target.getAttribute('value') || '',
        name: target.getAttribute('name') || '',
        testId: target.getAttribute('data-testid') || '',
      };
    });
    if (isCommitControl(control)) return 'person_required';
    await this.tab(userId, installationId);
    await locator.click();
    return 'clicked';
  }

  async type(userId: string, installationId: string, selector: string, text: string): Promise<void> {
    const page = await this.tab(userId, installationId);
    if (/\b(login|signin|sign-in|auth|checkpoint|verify)\b/i.test(page.url())) {
      throw new Error('Login and verification pages require the person to take control.');
    }
    const locator = page.locator(selector);
    if (await locator.count() !== 1) throw new Error('The typing target must identify exactly one element.');
    const secretField = await locator.evaluate((element) => {
      const field = element as HTMLInputElement;
      const hint = `${field.type || ''} ${field.name || ''} ${field.autocomplete || ''} `
        + `${field.getAttribute('aria-label') || ''} ${field.getAttribute('placeholder') || ''}`;
      return /password|passcode|one.time|otp|verification|secret|token|username|e.mail/i.test(hint);
    });
    if (secretField) throw new Error('Login and verification fields require the person to take control.');
    if (text.length > 10_000) throw new Error('Text is too long for this computer trial.');
    await this.tab(userId, installationId);
    await locator.fill(text);
  }

  async screenshot(userId: string, installationId: string): Promise<Buffer> {
    const page = await this.tab(userId, installationId);
    const bytes = await page.screenshot({ type: 'png', animations: 'disabled', scale: 'css' });
    if (bytes.length > MAX_SCREENSHOT_BYTES) throw new Error('Screenshot exceeds the computer trial limit.');
    return bytes;
  }

  async requestTakeover(userId: string, installationId: string): Promise<void> {
    const page = await this.tab(userId, installationId);
    await page.bringToFront();
    await this.takeoverState.set(userId, installationId, true);
    const state = await this.user(userId);
    state.humanActionSeen.delete(installationId);
    state.takeover.add(installationId);
  }

  async handBack(userId: string, installationId: string): Promise<void> {
    const state = await this.user(userId);
    if (!state.takeover.has(installationId)) throw new Error('No human takeover is active.');
    await this.abortPendingWrites(state, installationId);
    const old = await this.tab(userId, installationId, true);
    const current = new URL(old.url());
    const landing = current.protocol === 'https:' && this.config.allowedHosts.has(current.hostname.toLowerCase())
      ? `${current.origin}/` : 'about:blank';
    // Close the tainted page before clearing storage so its timers cannot
    // restore a human-entered credential. The blank replacement has no site
    // scripts; clear non-cookie storage before it navigates. Cookies remain.
    await old.close();
    const fresh = await state.context.newPage();
    const cdp = await state.context.newCDPSession(fresh);
    try {
      for (const host of this.config.allowedHosts) {
        await cdp.send('Storage.clearDataForOrigin', {
          origin: `https://${host}`,
          storageTypes: 'local_storage,indexeddb,cache_storage,service_workers,websql',
        });
      }
    } finally {
      await cdp.detach();
    }
    // A different tab on the shared profile may issue a write during clearing.
    await this.abortPendingWrites(state, installationId);
    state.tabs.delete(installationId);
    state.frames.delete(installationId);
    state.humanActionSeen.delete(installationId);
    const targetId = await this.targetId(state.context, fresh);
    await this.takeoverState.bind(userId, installationId, targetId);
    await this.attachPage(fresh);
    state.tabs.set(installationId, fresh);
    if (landing !== 'about:blank') await fresh.goto(landing, { waitUntil: 'domcontentloaded', timeout: ACTION_TIMEOUT_MS });
    await this.takeoverState.set(userId, installationId, false);
    state.takeover.delete(installationId);
  }

  async pendingWrites(userId: string, installationId: string): Promise<{
    id: string; method: string; url: string;
  }[]> {
    const state = await this.user(userId);
    if (!state.takeover.has(installationId)) return [];
    return [...state.pendingWrites].filter(([, write]) => write.installationId === installationId)
      .map(([id, write]) => {
        const url = new URL(write.url);
        return { id, method: write.method, url: `${url.origin}${url.pathname}` };
      });
  }

  async decideWrite(userId: string, installationId: string, id: string, approve: boolean): Promise<void> {
    const state = await this.user(userId);
    if (!state.takeover.has(installationId)) throw new Error('No human takeover is active.');
    const pending = state.pendingWrites.get(id);
    if (!pending || pending.installationId !== installationId) throw new Error('Pending write is unavailable.');
    state.pendingWrites.delete(id);
    clearTimeout(pending.timer);
    if (approve) await pending.route.fallback(); else await pending.route.abort();
  }

  private async frame(userId: string, installationId: string): Promise<{
    bytes: Buffer; revision: string; width: number; height: number;
  }> {
    const page = await this.tab(userId, installationId, true);
    const state = await this.user(userId);
    const bytes = await page.screenshot({ type: 'png', animations: 'disabled', scale: 'css' });
    if (bytes.length > MAX_SCREENSHOT_BYTES) throw new Error('Screenshot exceeds the computer trial limit.');
    const viewport = page.viewportSize();
    const isPng = bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG_SIGNATURE);
    const width = isPng ? bytes.readUInt32BE(16) : viewport?.width;
    const height = isPng ? bytes.readUInt32BE(20) : viewport?.height;
    if (!width || !height) throw new Error('Computer viewport is unavailable.');
    const revision = (state.revisions.get(installationId) || 0) + 1;
    state.revisions.set(installationId, revision);
    const frame = {
      bytes, revision: `${state.epoch}:${revision}`,
      width, height,
    };
    state.frames.set(installationId, frame);
    return frame;
  }

  async takeoverStatus(userId: string, installationId: string): Promise<{
    active: boolean; url: string; frameWidth: number; frameHeight: number; frameRevision: string;
    pendingWrites: { id: string; method: string; url: string }[];
  }> {
    const page = await this.tab(userId, installationId, true);
    const frame = await this.frame(userId, installationId);
    return {
      active: (await this.user(userId)).takeover.has(installationId), url: page.url(),
      frameWidth: frame.width, frameHeight: frame.height, frameRevision: frame.revision,
      pendingWrites: await this.pendingWrites(userId, installationId),
    };
  }

  async humanScreenshot(userId: string, installationId: string): Promise<Buffer> {
    const state = await this.user(userId);
    return (state.frames.get(installationId) || await this.frame(userId, installationId)).bytes;
  }

  private async humanTab(userId: string, installationId: string): Promise<Page> {
    const page = await this.tab(userId, installationId, true);
    if (!(await this.user(userId)).takeover.has(installationId)) throw new Error('No human takeover is active.');
    return page;
  }

  private async consumeFreshFrame(userId: string, installationId: string, revision: string): Promise<{
    width: number; height: number;
  }> {
    const state = await this.user(userId);
    const frame = state.frames.get(installationId);
    if (!frame || revision !== frame.revision) {
      throw new Error('Stale computer frame. Refresh before acting.');
    }
    // Consume before awaiting CDP so two concurrent HTTP actions cannot both
    // act on the same image, even if the first action is still in flight.
    state.frames.delete(installationId);
    return frame;
  }

  async humanClick(userId: string, installationId: string, x: number, y: number, revision: string): Promise<void> {
    const page = await this.humanTab(userId, installationId);
    const frame = await this.consumeFreshFrame(userId, installationId, revision);
    if (!Number.isFinite(x) || !Number.isFinite(y)
      || x < 0 || y < 0 || x >= frame.width || y >= frame.height) {
      throw new Error('Invalid click coordinates.');
    }
    (await this.user(userId)).humanActionSeen.add(installationId);
    await page.mouse.click(x, y);
  }

  async humanType(userId: string, installationId: string, text: string, revision: string): Promise<void> {
    const page = await this.humanTab(userId, installationId);
    if (text.length > 10_000) throw new Error('Text is too long.');
    await this.consumeFreshFrame(userId, installationId, revision);
    (await this.user(userId)).humanActionSeen.add(installationId);
    await page.keyboard.insertText(text);
  }

  async humanPress(userId: string, installationId: string, key: string, revision: string): Promise<void> {
    const page = await this.humanTab(userId, installationId);
    if (!HUMAN_KEYS.has(key)) throw new Error('Unsupported key.');
    await this.consumeFreshFrame(userId, installationId, revision);
    (await this.user(userId)).humanActionSeen.add(installationId);
    await page.keyboard.press(key);
  }
}

export const agentComputerBroker = new AgentComputerBroker();
