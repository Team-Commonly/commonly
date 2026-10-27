const { AgentComputerBroker, isCommitControl } = require('../../../services/agentComputerBroker');

const OWNER = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_OWNER = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const FIRST = '111111111111111111111111';
const SECOND = '222222222222222222222222';
let nextTarget = 0;

const fakePage = (events = []) => {
  let current = 'about:blank';
  let tabName = '';
  const page = {
    targetId: `cdp-target-${++nextTarget}`,
    isClosed: () => false,
    close: jest.fn(async () => { events.push('old.close'); }),
    setDefaultTimeout: jest.fn(),
    route: jest.fn(),
    addInitScript: jest.fn(),
    evaluate: jest.fn(async (_callback, name) => {
      if (name !== undefined) tabName = name;
      return tabName;
    }),
    goto: jest.fn(async (url) => { current = url; }),
    url: () => current,
    title: jest.fn(async () => `Title ${current}`),
    locator: jest.fn((selector) => ({
      count: async () => 1,
      ariaSnapshot: async () => `snapshot for ${current}`,
      evaluate: async (callback) => (selector === 'password'
        ? true : selector === 'send' ? {
          tag: 'button', type: 'button', role: '', label: 'Send', text: '', formAction: '',
        } : {
          tag: 'button', type: 'button', role: '', label: 'Open menu', text: '', formAction: '',
        }),
      click: page._click,
      fill: page._fill,
    })),
    _click: jest.fn(),
    _fill: jest.fn(),
    screenshot: jest.fn(async () => Buffer.from('png')),
    viewportSize: () => ({ width: 1280, height: 720 }),
    bringToFront: jest.fn(),
    mouse: { click: jest.fn() },
    keyboard: { insertText: jest.fn(), press: jest.fn() },
  };
  return page;
};

const setup = (status = 'absent', resolve = jest.fn(async () => ['151.101.1.1'])) => {
  const pages = [];
  const cdpCommands = [];
  const events = [];
  const context = { route: jest.fn(), routeWebSocket: jest.fn(), on: jest.fn(), newPage: jest.fn(async () => {
    const page = fakePage(events);
    pages.push(page);
    return page;
  }), pages: () => pages.slice(0, 2),
  newCDPSession: jest.fn(async (page) => ({
    send: jest.fn(async (command, args) => {
      cdpCommands.push({ command, args });
      events.push(`${command}:${page.targetId}`);
      return { targetInfo: { targetId: page.targetId } };
    }),
    detach: jest.fn(),
  })) };
  const browser = { contexts: () => [context], on: jest.fn() };
  const request = jest.fn(async (_url, method) => (method === 'GET'
    ? { sessions: status === 'absent' ? [] : [{ id: 'one', status }] }
    : { id: 'one', status: 'live' }));
  const connect = jest.fn(async (endpoint) => (endpoint.includes(OWNER) ? browser : {
    contexts: () => [{ route: jest.fn(), routeWebSocket: jest.fn(), on: jest.fn(), newCDPSession: context.newCDPSession, newPage: async () => {
      const page = fakePage(events);
      pages.push(page);
      return page;
    }, pages: () => [] }],
    on: jest.fn(),
  }));
  const wake = jest.fn(async () => {});
  const held = new Set();
  const bound = new Map();
  const takeoverState = {
    get: jest.fn(async (userId, installationId) => held.has(`${userId}:${installationId}`)),
    set: jest.fn(async (userId, installationId, active) => {
      const key = `${userId}:${installationId}`;
      if (active) held.add(key); else held.delete(key);
    }),
    bindings: jest.fn(async (userId) => [...bound]
      .filter(([key]) => key.startsWith(`${userId}:`))
      .map(([key, targetId]) => ({ installationId: key.slice(userId.length + 1), targetId }))),
    bind: jest.fn(async (userId, installationId, targetId) => {
      bound.set(`${userId}:${installationId}`, targetId);
    }),
  };
  const config = {
    apiUrl: (id) => `http://steel-${id}:3000`,
    cdpUrl: (id) => `http://steel-${id}:9223`,
    allowedHosts: new Set(['www.linkedin.com']),
  };
  return {
    broker: new AgentComputerBroker(config, request, connect, wake, takeoverState, resolve),
    pages, context, request, connect, wake, takeoverState, config, cdpCommands, events,
  };
};

describe('agent computer broker (fake Steel and CDP)', () => {
  test('one Steel session per owner, separate persistent tabs per installation', async () => {
    const { broker, pages, context, request, connect, wake } = setup();
    const [a, b] = await Promise.all([
      broker.navigate(OWNER, FIRST, 'https://www.linkedin.com/in/a'),
      broker.navigate(OWNER, SECOND, 'https://www.linkedin.com/in/b'),
    ]);
    expect(request).toHaveBeenCalledTimes(2); // one list, one broker-owned create
    expect(request.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(context.newPage).toHaveBeenCalledTimes(2);
    expect(a.url).toContain('/in/a');
    expect(b.url).toContain('/in/b');
    expect((await broker.snapshot(OWNER, FIRST)).text).toContain('/in/a');
    expect((await broker.snapshot(OWNER, SECOND)).text).toContain('/in/b');
    expect(pages).toHaveLength(2);
    await broker.navigate(OTHER_OWNER, FIRST, 'https://www.linkedin.com/in/c');
    expect(connect).toHaveBeenCalledTimes(2);
    expect(wake).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(2);
    expect((await broker.snapshot(OWNER, FIRST)).text).toContain('/in/a');
    expect((await broker.snapshot(OTHER_OWNER, FIRST)).text).toContain('/in/c');
  });

  test('attaches to an existing live session without creating another', async () => {
    const { broker, request } = setup('live');
    await broker.snapshot(OWNER, FIRST);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]).toBe('GET');
  });

  test('concurrent calls from one installation cannot create two tabs', async () => {
    const { broker, context } = setup('live');
    await Promise.all([broker.snapshot(OWNER, FIRST), broker.snapshot(OWNER, FIRST)]);
    expect(context.newPage).toHaveBeenCalledTimes(1);
  });

  test('an existing idle session is active and must never be relaunched', async () => {
    const { broker, request } = setup('idle');
    await broker.snapshot(OWNER, FIRST);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]).toBe('GET');
  });

  test('agent cannot navigate outside the trial or click a send control', async () => {
    const { broker, pages } = setup();
    await expect(broker.navigate(OWNER, FIRST, 'https://evil.example/')).rejects.toThrow('outside');
    await broker.snapshot(OWNER, FIRST);
    expect(await broker.click(OWNER, FIRST, 'send')).toBe('person_required');
    expect(pages[0]._click).not.toHaveBeenCalled();
    expect(await broker.click(OWNER, FIRST, 'menu')).toBe('clicked');
    expect(pages[0]._click).toHaveBeenCalledTimes(1);
    expect(isCommitControl({ tag: 'input', type: 'submit', role: '', label: '', text: '', formAction: '' })).toBe(true);
    expect(isCommitControl({ tag: 'div', type: '', role: '', label: '', text: 'Open', formAction: '' })).toBe(true);
  });

  test('login fields require takeover; takeover blocks agent actions until hand-back', async () => {
    const { broker, pages, context, takeoverState, cdpCommands, events } = setup();
    await broker.snapshot(OWNER, FIRST);
    await expect(broker.type(OWNER, FIRST, 'password', 'secret')).rejects.toThrow('require the person');
    expect(pages[0]._fill).not.toHaveBeenCalled();
    await broker.requestTakeover(OWNER, FIRST);
    expect(takeoverState.set).toHaveBeenCalledWith(OWNER, FIRST, true);
    const status = await broker.takeoverStatus(OWNER, FIRST);
    expect(status).toMatchObject({ active: true, frameWidth: 1280, frameHeight: 720 });
    expect(status.frameRevision).toMatch(/^[0-9a-f-]+:1$/);
    const intercept = context.route.mock.calls[0][1];
    const mutating = { request: () => ({ method: () => 'POST', url: () => 'https://www.linkedin.com/send',
      frame: () => ({ page: () => pages[0] }), isNavigationRequest: () => false }),
      abort: jest.fn(), fallback: jest.fn() };
    // Taking over alone does not authorize a queued request.
    await intercept(mutating);
    expect(mutating.abort).toHaveBeenCalledTimes(1);
    await expect(broker.snapshot(OWNER, FIRST)).rejects.toThrow('person has control');
    await broker.humanClick(OWNER, FIRST, 20, 30, status.frameRevision);
    await expect(broker.humanType(OWNER, FIRST, 'stale', status.frameRevision)).rejects.toThrow('Stale computer frame');
    const afterClick = await broker.takeoverStatus(OWNER, FIRST);
    await broker.humanType(OWNER, FIRST, 'entered by the person', afterClick.frameRevision);
    const afterType = await broker.takeoverStatus(OWNER, FIRST);
    await broker.humanPress(OWNER, FIRST, 'Enter', afterType.frameRevision);
    expect(pages[0].mouse.click).toHaveBeenCalledWith(20, 30);
    expect(pages[0].keyboard.insertText).toHaveBeenCalledWith('entered by the person');
    await intercept(mutating);
    const pending = await broker.pendingWrites(OWNER, FIRST);
    expect(pending).toMatchObject([{ method: 'POST', url: 'https://www.linkedin.com/send' }]);
    expect(mutating.fallback).not.toHaveBeenCalled();
    await broker.decideWrite(OWNER, FIRST, pending[0].id, true);
    expect(mutating.fallback).toHaveBeenCalledTimes(1);
    await broker.handBack(OWNER, FIRST);
    expect(events.indexOf('old.close')).toBeLessThan(events.indexOf(`Storage.clearDataForOrigin:${pages[1].targetId}`));
    expect(events).not.toContain(`Storage.clearDataForOrigin:${pages[0].targetId}`);
    expect(cdpCommands).toContainEqual({
      command: 'Storage.clearDataForOrigin',
      args: {
        origin: 'https://www.linkedin.com',
        storageTypes: 'local_storage,indexeddb,cache_storage,service_workers,websql',
      },
    });
    expect(takeoverState.set).toHaveBeenCalledWith(OWNER, FIRST, false);
    await intercept(mutating);
    expect(mutating.abort).toHaveBeenCalledTimes(2);
    await expect(broker.humanType(OWNER, FIRST, 'no', status.frameRevision)).rejects.toThrow('No human takeover');
    expect((await broker.snapshot(OWNER, FIRST)).text).toContain('snapshot');
    expect(pages[0].close).toHaveBeenCalledTimes(1);
    expect(context.newPage).toHaveBeenCalledTimes(2);
  });

  test('a restarted broker reloads the human pause before opening an agent tab', async () => {
    const fixture = setup('live');
    await fixture.broker.requestTakeover(OWNER, FIRST);
    const oldRevision = (await fixture.broker.takeoverStatus(OWNER, FIRST)).frameRevision;
    const restarted = new AgentComputerBroker(
      fixture.config, fixture.request, fixture.connect, fixture.wake, fixture.takeoverState,
    );
    await expect(restarted.snapshot(OWNER, FIRST)).rejects.toThrow('person has control');
    expect(fixture.context.newPage).toHaveBeenCalledTimes(1);
    const current = await restarted.takeoverStatus(OWNER, FIRST);
    expect(current.frameRevision).not.toBe(oldRevision);
    await expect(restarted.humanClick(OWNER, FIRST, 10, 10, oldRevision)).rejects.toThrow('Stale computer frame');
    expect(fixture.request.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(0);
  });

  test('recovery follows CDP target bindings, never page-writable window.name', async () => {
    const fixture = setup('live');
    await fixture.broker.snapshot(OWNER, FIRST);
    // A page can set its name to another installation and open an about:blank
    // popup with the same name. Neither page script can set a CDP target id.
    await fixture.pages[0].evaluate(() => {}, `commonly-installation:${SECOND}`);
    const popup = fakePage();
    await popup.evaluate(() => {}, `commonly-installation:${FIRST}`);
    fixture.pages.push(popup);
    const restarted = new AgentComputerBroker(
      fixture.config, fixture.request, fixture.connect, fixture.wake, fixture.takeoverState,
    );
    expect((await restarted.snapshot(OWNER, FIRST)).text).toContain('snapshot');
    expect(fixture.context.newPage).toHaveBeenCalledTimes(1);
    await restarted.snapshot(OWNER, SECOND);
    expect(fixture.context.newPage).toHaveBeenCalledTimes(2);
    expect(fixture.pages[1].locator).not.toHaveBeenCalled();
  });

  test('concurrent human actions cannot reuse one frame revision', async () => {
    const { broker, pages } = setup('live');
    await broker.requestTakeover(OWNER, FIRST);
    const { frameRevision } = await broker.takeoverStatus(OWNER, FIRST);
    const results = await Promise.allSettled([
      broker.humanClick(OWNER, FIRST, 10, 10, frameRevision),
      broker.humanClick(OWNER, FIRST, 20, 20, frameRevision),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(pages[0].mouse.click).toHaveBeenCalledTimes(1);
  });

  test('every frame and every subresource is held to the trial, not only the tab', async () => {
    const resolve = jest.fn(async (host) => (host === 'intranet.example' ? ['10.1.2.3'] : ['151.101.1.1']));
    const { broker, pages, context } = setup('live', resolve);
    await broker.snapshot(OWNER, FIRST);
    const intercept = context.route.mock.calls[0][1];
    const verdict = async (url, { navigation = false, subframe = false } = {}) => {
      const route = { request: () => ({ method: () => 'GET', url: () => url, isNavigationRequest: () => navigation,
        frame: () => ({ page: () => pages[0], parentFrame: () => (subframe ? {} : null) }) }),
      abort: jest.fn(), fallback: jest.fn() };
      await intercept(route);
      if (route.fallback.mock.calls.length) return 'allowed';
      return route.abort.mock.calls.length ? 'refused' : 'held';
    };
    expect(await verdict('https://www.linkedin.com/feed/', { navigation: true })).toBe('allowed');
    expect(await verdict('https://www.linkedin.com/embed', { navigation: true, subframe: true })).toBe('allowed');
    expect(await verdict('https://elsewhere.example/', { navigation: true, subframe: true })).toBe('refused');
    expect(await verdict('https://elsewhere.example/', { navigation: true })).toBe('refused');
    expect(await verdict('https://10.0.0.1/pixel.png')).toBe('refused');
    expect(await verdict('http://169.254.169.254/computeMetadata/v1/')).toBe('refused');
    expect(await verdict('http://[::ffff:10.0.0.1]/pixel.png')).toBe('refused');
    expect(await verdict('https://intranet.example/logo.png')).toBe('refused');
    expect(await verdict('https://cdn.example/app.js')).toBe('allowed');
    expect(resolve).toHaveBeenCalledWith('cdn.example');
  });

  test('a WebSocket is held to the subresource rule before any tab opens', async () => {
    const resolve = jest.fn(async (host) => (host === 'intranet.example' ? ['10.1.2.3'] : ['151.101.1.1']));
    const { broker, context } = setup('live', resolve);
    await broker.snapshot(OWNER, FIRST);
    expect(context.routeWebSocket).toHaveBeenCalledTimes(1);
    // Playwright routes only sockets created after the route is installed.
    expect(context.routeWebSocket.mock.invocationCallOrder[0])
      .toBeLessThan(context.newPage.mock.invocationCallOrder[0]);
    const [matches, guard] = context.routeWebSocket.mock.calls[0];
    expect(matches(new URL('wss://anything.example/socket'))).toBe(true);
    const verdict = async (url) => {
      const ws = { url: () => url, connectToServer: jest.fn(), close: jest.fn(async () => {}) };
      await guard(ws);
      if (ws.connectToServer.mock.calls.length) return ws.close.mock.calls.length ? 'both' : 'connected';
      return ws.close.mock.calls.length ? 'closed' : 'held';
    };
    expect(await verdict('wss://www.linkedin.com/realtime')).toBe('connected');
    expect(await verdict('wss://cdn.example/socket')).toBe('connected');
    expect(resolve).toHaveBeenCalledWith('cdn.example');
    expect(await verdict('ws://10.0.0.1:8080/')).toBe('closed');
    expect(await verdict('ws://169.254.169.254/')).toBe('closed');
    expect(await verdict('ws://[::ffff:10.0.0.1]/')).toBe('closed');
    expect(await verdict('wss://intranet.example/socket')).toBe('closed');
    expect(await verdict('not a url')).toBe('closed');
  });

  test('a redirect hop that leaves the trial closes the tab', async () => {
    const resolve = jest.fn(async (host) => (host === 'intranet.example' ? ['10.1.2.3'] : ['151.101.1.1']));
    const { broker, pages, context } = setup('live', resolve);
    await broker.snapshot(OWNER, FIRST);
    const onRequest = context.on.mock.calls.find(([event]) => event === 'request')[1];
    const hop = (url, navigation, page = pages[0]) => ({ redirectedFrom: () => ({}), url: () => url,
      isNavigationRequest: () => navigation, frame: () => ({ page: () => page }) });
    await onRequest(hop('https://www.linkedin.com/login', true));
    await onRequest(hop('https://cdn.example/app.js', false));
    expect(pages[0].close).not.toHaveBeenCalled();
    await onRequest(hop('https://elsewhere.example/', true));
    expect(pages[0].close).toHaveBeenCalledTimes(1);
    // The closed tab is gone from the broker; the next action gets a fresh one.
    await broker.snapshot(OWNER, FIRST);
    expect(context.newPage).toHaveBeenCalledTimes(2);
    await onRequest(hop('https://intranet.example/logo.png', false, pages[1]));
    expect(pages[1].close).toHaveBeenCalledTimes(1);
  });

  test('a navigation that lands off the trial is refused and its tab closed', async () => {
    const { broker, pages } = setup('live');
    await broker.snapshot(OWNER, FIRST);
    pages[0].goto.mockImplementationOnce(async () => {});
    pages[0].url = () => 'https://elsewhere.example/landing';
    await expect(broker.navigate(OWNER, FIRST, 'https://www.linkedin.com/feed/'))
      .rejects.toThrow('outside this computer trial');
    expect(pages[0].close).toHaveBeenCalledTimes(1);
  });

  test('the first request from an unowned popup is denied at the context boundary', async () => {
    const { broker, context } = setup('live');
    await broker.snapshot(OWNER, FIRST);
    const intercept = context.route.mock.calls[0][1];
    const popup = { request: () => ({ method: () => 'POST',
      frame: () => ({ page: () => fakePage() }) }), abort: jest.fn() };
    await intercept(popup);
    expect(popup.abort).toHaveBeenCalledTimes(1);
  });

  test('takeover stops an agent click paused during target inspection', async () => {
    const { broker, pages } = setup('live');
    await broker.snapshot(OWNER, FIRST);
    let entered;
    let release;
    const inspecting = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const originalLocator = pages[0].locator;
    pages[0].locator = jest.fn((selector) => {
      const locator = originalLocator(selector);
      const originalEvaluate = locator.evaluate;
      locator.evaluate = async (...args) => {
        const result = await originalEvaluate(...args);
        entered();
        await gate;
        return result;
      };
      return locator;
    });
    const clicking = broker.click(OWNER, FIRST, 'menu');
    await inspecting;
    await broker.requestTakeover(OWNER, FIRST);
    release();
    await expect(clicking).rejects.toThrow('person has control');
    expect(pages[0]._click).not.toHaveBeenCalled();
  });
});
