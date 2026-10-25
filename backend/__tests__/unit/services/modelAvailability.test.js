jest.mock('axios', () => ({ get: jest.fn() }));
const axios = require('axios');

const route = (name, id, upstream = name) => ({ model_name: name, model_info: { id }, litellm_params: { model: upstream } });
let catalog;
const originalBase = process.env.LITELLM_BASE_URL;
const originalKey = process.env.LITELLM_MASTER_KEY;
beforeEach(() => {
  jest.resetModules();
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  process.env.LITELLM_BASE_URL = 'http://gateway/v1';
  process.env.LITELLM_MASTER_KEY = 'test-key';
  catalog = require('../../../services/modelAvailability');
});
afterEach(() => {
  jest.useRealTimers();
  if (originalBase === undefined) delete process.env.LITELLM_BASE_URL; else process.env.LITELLM_BASE_URL = originalBase;
  if (originalKey === undefined) delete process.env.LITELLM_MASTER_KEY; else process.env.LITELLM_MASTER_KEY = originalKey;
});
const replies = (routes, healthy, unhealthy = []) => {
  require('axios').get.mockImplementation((url) => Promise.resolve({ data: url.endsWith('/model/info')
    ? { data: routes } : { healthy_endpoints: healthy, unhealthy_endpoints: unhealthy } }));
};

test('a configured route with rejected credentials is unavailable, then recovers after cache expiry', async () => {
  const routes = [route('anthropic/claude-opus-4-6', 'c1'), route('new/provider-model', 'new')];
  replies(routes, [{ model_id: 'new' }], [{ model_id: 'c1', error: '401 AuthenticationError secret-test-value' }]);
  let result = await catalog.getModelCatalog();
  expect(catalog.modelAvailability(result, 'anthropic/claude-opus-4-6')).toMatchObject({ available: false, reason: 'The upstream rejected this route’s credentials' });
  expect(JSON.stringify(result)).not.toContain('secret-test-value');
  expect(catalog.modelAvailability(result, 'new/provider-model').available).toBe(true);
  replies(routes, [{ model_id: 'c1' }, { model_id: 'new' }]);
  expect((await catalog.getModelCatalog())).toBe(result);
  jest.advanceTimersByTime(300001);
  result = await catalog.getModelCatalog();
  expect(catalog.modelAvailability(result, 'anthropic/claude-opus-4-6')).toMatchObject({ available: true, reason: null });
});

test('keeps removed and previously offered choices visible without a substitute', async () => {
  replies([route('future-model', 'f')], [{ model_id: 'f' }]);
  await catalog.getModelCatalog();
  jest.advanceTimersByTime(300001);
  replies([], []);
  const result = await catalog.getModelCatalog();
  expect(catalog.modelAvailability(result, 'future-model')).toMatchObject({ id: 'future-model', available: false, reason: 'This model has no configured route on this instance' });
  expect(result.models.find((model) => model.id === 'anthropic/claude-opus-4-6')).toMatchObject({ available: false });
});

test('does not use an unrelated healthy deployment to green a failed route', async () => {
  replies([route('route-a', 'a', 'same-upstream'), route('route-b', 'b', 'same-upstream')],
    [{ model_id: 'a', model: 'same-upstream' }], [{ model_id: 'b', model: 'same-upstream', error: '401' }]);
  const result = await catalog.getModelCatalog();
  expect(catalog.modelAvailability(result, 'route-a').available).toBe(true);
  expect(catalog.modelAvailability(result, 'route-b').available).toBe(false);
});

test('a healthy deployment can serve its group even if another deployment fails', async () => {
  replies([route('group', 'a'), route('group', 'b')], [{ model_id: 'b' }], [{ model_id: 'a', error: '401' }]);
  expect(catalog.modelAvailability(await catalog.getModelCatalog(), 'group').available).toBe(true);
});

test('fails closed on missing health, expiry or malformed responses; shares concurrent refreshes', async () => {
  const get = require('axios').get;
  replies([route('one', '1')], [{ model_id: '1' }]);
  await Promise.all([catalog.getModelCatalog(), catalog.getModelCatalog()]);
  expect(get).toHaveBeenCalledTimes(2);
  jest.advanceTimersByTime(300001);
  get.mockImplementation((url) => url.endsWith('/health') ? Promise.reject(new Error('secret')) : Promise.resolve({ data: { data: [route('one', '1')] } }));
  expect(catalog.modelAvailability(await catalog.getModelCatalog(), 'one')).toMatchObject({ available: false, reason: 'This route’s health could not be confirmed' });
});

test('does not treat gateway readiness or route configuration as model health', async () => {
  require('axios').get.mockResolvedValue({ data: { data: [route('one', '1')], status: 'healthy' } });
  expect(catalog.modelAvailability(await catalog.getModelCatalog(), 'one').available).toBe(false);
});

test('does not guess across ambiguous legacy health results without deployment ids', async () => {
  replies([route('a', '1', 'shared'), route('b', '2', 'shared')], [{ model: 'shared' }]);
  const result = await catalog.getModelCatalog();
  expect(catalog.modelAvailability(result, 'a').available).toBe(false);
  expect(catalog.modelAvailability(result, 'b').available).toBe(false);
});

test('a timed-out deployment cannot erase healthy results and non-chat routes are not probed', async () => {
  const get = require('axios').get;
  get.mockImplementation((url, config) => {
    if (url.endsWith('/model/info')) return Promise.resolve({ data: { data: [
      route('good', 'g'), route('stalled', 's'),
      { ...route('embedding-only', 'e'), model_info: { id: 'e', mode: 'embedding' } },
    ] } });
    if (config.params.model_id === 'g') return Promise.resolve({ data: { healthy_endpoints: [{ model_id: 'g' }] } });
    return Promise.reject(new Error('timeout'));
  });
  const result = await catalog.getModelCatalog();
  expect(catalog.modelAvailability(result, 'good').available).toBe(true);
  expect(catalog.modelAvailability(result, 'stalled').available).toBe(false);
  expect(result.models.some((model) => model.id === 'embedding-only')).toBe(false);
  expect(get.mock.calls.filter(([, config]) => config.params).map(([, config]) => config.params.model_id)).toEqual(['g', 's']);
});
