import {
  resetUsageEventsForTest, screenPodId, screenTemplate, setUsageEventsEnabled, trackPublic, trackUsage, trackUsageOnce,
} from '../utils/usageEvents';

// D286 (F399): the client sends fixed names and route templates only, waits
// for the person's Settings choice, never sends a token in a body, and stays
// silent under DNT/GPC or when signed out.
describe('usage events client', () => {
  const fetchMock = jest.fn(() => Promise.resolve({ ok: true }));
  const podId = '65f0a1b2c3d4e5f6a7b8c9d0';
  const bodies = () => fetchMock.mock.calls.map((call) => JSON.parse((call as unknown as [string, RequestInit])[1].body as string));

  beforeEach(() => {
    jest.useFakeTimers();
    resetUsageEventsForTest();
    fetchMock.mockClear();
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
    window.localStorage.setItem('token', 'session-token');
    Object.defineProperty(navigator, 'doNotTrack', { value: '0', configurable: true });
    Object.defineProperty(navigator, 'globalPrivacyControl', { value: false, configurable: true });
    window.history.pushState({}, '', `/v2/pods/${podId}`);
  });
  afterEach(() => {
    jest.useRealTimers();
    window.localStorage.clear();
  });

  it('maps a path to its route template and pod, never the id itself', () => {
    expect(screenTemplate(`/v2/pods/${podId}/board`)).toBe('/pods/:podId/board');
    expect(screenTemplate('/v2/invite/secret-token')).toBe('/invite/:token');
    expect(screenTemplate('/v2')).toBe('/');
    expect(screenTemplate('/v2/somewhere/else')).toBe('other');
    expect(screenPodId(`/v2/pods/${podId}/tasks/t1/record`)).toBe(podId);
    expect(screenPodId('/v2/pods/not-an-id')).toBeUndefined();
  });

  it('waits for the Settings choice, then batches with keepalive and the Bearer header', () => {
    trackUsage('screen-view');
    trackUsage('invite-open');
    jest.advanceTimersByTime(5000);
    expect(fetchMock).not.toHaveBeenCalled();
    setUsageEventsEnabled(true);
    jest.advanceTimersByTime(2000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/stats\/ui-event$/);
    expect(init.keepalive).toBe(true);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer session-token');
    expect(init.body).not.toContain('session-token');
    expect(bodies()[0].events).toEqual([
      { name: 'screen-view', screen: '/pods/:podId', podId },
      { name: 'invite-open', screen: '/pods/:podId', podId },
    ]);
  });

  it('drops waiting events when the choice is off, and sends nothing after', () => {
    trackUsage('screen-view');
    setUsageEventsEnabled(false);
    trackUsage('screen-view');
    jest.advanceTimersByTime(5000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends nothing under Do Not Track or Global Privacy Control, or when signed out', () => {
    setUsageEventsEnabled(true);
    Object.defineProperty(navigator, 'globalPrivacyControl', { value: true, configurable: true });
    trackUsage('screen-view');
    trackPublic('register-view');
    Object.defineProperty(navigator, 'globalPrivacyControl', { value: false, configurable: true });
    Object.defineProperty(navigator, 'doNotTrack', { value: '1', configurable: true });
    trackUsage('screen-view');
    Object.defineProperty(navigator, 'doNotTrack', { value: '0', configurable: true });
    window.localStorage.removeItem('token');
    trackUsage('screen-view');
    jest.advanceTimersByTime(5000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends a once-event once per page load', () => {
    setUsageEventsEnabled(true);
    trackUsageOnce('k', 'composer-focus');
    trackUsageOnce('k', 'composer-focus');
    jest.advanceTimersByTime(2000);
    expect(bodies()[0].events).toHaveLength(1);
  });

  it('counts a logged-out page by template and campaign code, with no credentials', () => {
    window.localStorage.removeItem('token');
    window.history.pushState({}, '', '/v2/invite/secret-token?ref=x');
    trackPublic('invite-page-view');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/stats\/public-hit$/);
    expect(init.headers).not.toHaveProperty('Authorization');
    expect(init.credentials).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({ name: 'invite-page-view', page: '/invite/:token', ref: 'x' });
  });

  it('a signed-in visitor sends no logged-out counts', () => {
    trackPublic('register-view');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
