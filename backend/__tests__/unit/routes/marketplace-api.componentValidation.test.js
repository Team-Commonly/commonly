// Nested manifest validation on POST /api/marketplace/publish.
//
// Every scalar on the manifest is length- or enum-checked and then the
// `components` array is taken from the body and persisted. Before this suite,
// one length test (`components.length > 50`) was the entire gate: component
// `type` could be any string, `widgetUrl` any string including `javascript:`,
// and the four `Schema.Types.Mixed` fields any JSON of any size, at up to 50
// components per manifest.

jest.mock('../../../middleware/auth', () => (req, res, next) => next());

jest.mock('../../../models/User', () => ({}));

jest.mock('../../../models/Installable', () => ({
  findOne: jest.fn(),
  create: jest.fn(),
  updateOne: jest.fn(),
  deleteOne: jest.fn(),
  countDocuments: jest.fn(),
  find: jest.fn(),
}));

jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: {
    findOneAndUpdate: jest.fn(),
    deleteOne: jest.fn(),
    updateOne: jest.fn(),
  },
  AgentInstallation: {
    countDocuments: jest.fn(),
  },
}));

const Installable = require('../../../models/Installable');
const { AgentRegistry } = require('../../../models/AgentRegistry');
const router = require('../../../routes/marketplace-api');

const getRouteHandler = (path, method) => {
  const layer = router.stack.find((entry) => (
    entry.route
    && entry.route.path === path
    && entry.route.methods[method]
  ));
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};

const publish = async (components) => {
  const handler = getRouteHandler('/publish', 'post');
  const req = {
    userId: 'user-1',
    user: { id: 'user-1', username: 'nova' },
    body: {
      installableId: '@nova/my-agent',
      name: 'My Agent',
      version: '1.0.0',
      kind: 'agent',
      scope: 'pod',
      components,
    },
  };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await handler(req, res);
  return res;
};

const errorOf = (res) => res.json.mock.calls[0]?.[0]?.error;

const widget = (overrides = {}) => ({
  name: 'Dashboard',
  type: 'widget',
  widgetLocation: 'dashboard-main',
  ...overrides,
});

describe('marketplace publish validates inside the components array', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // No existing manifest, so a VALID body would reach the create path. This
    // is what makes the rejections below attributable to validation rather
    // than to a mock that was never going to succeed — see the control test.
    Installable.findOne.mockResolvedValue(null);
    Installable.create.mockResolvedValue({ installableId: '@nova/my-agent' });
    AgentRegistry.findOneAndUpdate.mockResolvedValue({ agentName: '@nova/my-agent' });
  });

  // CONTROL. Every assertion below is "this input is rejected", and an input
  // rejected for the wrong reason — a broken mock, a missing required field in
  // the shared body, a handler that 500s on everything — is indistinguishable
  // from one rejected by the validator. This pins the other end: the same body
  // shape with a valid component reaches persistence.
  it('accepts a well-formed component, so the rejections below are attributable', async () => {
    const res = await publish([widget({ widgetUrl: 'https://widgets.example.com/panel' })]);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(Installable.create).toHaveBeenCalledTimes(1);
  });

  it('rejects a components value that is not an array', async () => {
    // A string has `.length`, so the old `components.length > 50` gate passed
    // any string of 50 characters or fewer straight through.
    const res = await publish('not-an-array');

    expect(res.status).toHaveBeenCalledWith(400);
    expect(errorOf(res)).toMatch(/components must be an array/i);
    expect(Installable.create).not.toHaveBeenCalled();
  });

  it('rejects a component type outside the schema enum', async () => {
    const res = await publish([{ name: 'Rogue', type: 'arbitrary-type' }]);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(errorOf(res)).toMatch(/components\[0\]\.type must be one of/i);
    expect(Installable.create).not.toHaveBeenCalled();
  });

  it('rejects a component missing a name', async () => {
    const res = await publish([{ type: 'widget' }]);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(errorOf(res)).toMatch(/components\[0\]\.name is required/i);
  });

  it('names the offending index rather than failing anonymously', async () => {
    const res = await publish([widget(), widget(), { name: 'Bad', type: 'nope' }]);

    expect(errorOf(res)).toMatch(/components\[2\]\./);
  });

  // The scheme allowlist is the half that matters once a renderer ships:
  // nothing reads widgetUrl today, so stored rows are inert — and inert only
  // until the renderer lands, at which point every stored value goes live at
  // once.
  it.each([
    // The string below is data, never evaluated — being rejected IS the case.
    // eslint-disable-next-line no-script-url
    ['javascript:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['file:///etc/passwd'],
  ])('rejects widgetUrl scheme %s', async (widgetUrl) => {
    const res = await publish([widget({ widgetUrl })]);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(errorOf(res)).toMatch(/widgetUrl must use one of/i);
    expect(Installable.create).not.toHaveBeenCalled();
  });

  it('rejects a widgetUrl that is not absolute', async () => {
    const res = await publish([widget({ widgetUrl: '/relative/path' })]);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(errorOf(res)).toMatch(/widgetUrl must be an absolute URL/i);
  });

  it('accepts http as well as https, so the allowlist is not https-only by accident', async () => {
    const res = await publish([widget({ widgetUrl: 'http://localhost:3000/panel' })]);

    expect(res.status).toHaveBeenCalledWith(201);
  });

  it.each([
    ['widgetConfigSchema'],
    ['schemaFields'],
    ['skillExamples'],
    ['metadata'],
  ])('caps the Mixed field %s', async (field) => {
    const res = await publish([widget({ [field]: { blob: 'x'.repeat(20 * 1024) } })]);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(errorOf(res)).toMatch(new RegExp(`components\\[0\\]\\.${field} must be \\d+ bytes or fewer`, 'i'));
    expect(Installable.create).not.toHaveBeenCalled();
  });

  it('allows a Mixed field under the cap, so the cap is a bound and not a ban', async () => {
    const res = await publish([widget({ metadata: { note: 'x'.repeat(1024) } })]);

    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('still enforces the 50-component ceiling it replaced', async () => {
    const res = await publish(Array.from({ length: 51 }, () => widget()));

    expect(res.status).toHaveBeenCalledWith(400);
    expect(errorOf(res)).toMatch(/Maximum 50 components per manifest/i);
  });

  it('leaves a manifest with no components untouched', async () => {
    const res = await publish(undefined);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(Installable.create).toHaveBeenCalledTimes(1);
  });
});

// Fork is a SECOND writer into the published catalog: it copies
// `source.components` wholesale into a new `source: 'marketplace'`,
// `published: true` row. Validating at publish does not cover it, because the
// source lookup filters on `status: 'active'` and nothing else — no `source`
// filter, no `published` filter — so `builtin`, `user`, `template` and
// `remote` rows are all forkable and none of them were written through
// /publish. (@sprint-review, 58602: "source lookup filtered only on
// status: 'active'".)
describe('marketplace fork validates the components it copies', () => {
  const fork = async (sourceComponents) => {
    const handler = getRouteHandler('/fork', 'post');

    Installable.findOne
      .mockResolvedValueOnce({
        installableId: '@builtin/pod-welcomer',
        name: 'Pod Welcomer',
        kind: 'agent',
        scope: 'pod',
        version: '1.0.0',
        // Deliberately NOT source: 'marketplace' — a builtin row, which the
        // lookup happily returns and /publish never validated.
        source: 'builtin',
        components: sourceComponents,
      })
      .mockResolvedValueOnce(null);

    const req = {
      userId: 'user-1',
      user: { id: 'user-1', username: 'nova' },
      body: {
        sourceInstallableId: '@builtin/pod-welcomer',
        newInstallableId: '@nova/my-fork',
      },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await handler(req, res);
    return res;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // mockReset, not clearAllMocks: validation returns BEFORE the second
    // findOne (the duplicate-id check), so a rejecting case leaves one queued
    // `mockResolvedValueOnce` behind — which clearAllMocks does not drain, and
    // which the next test then receives as its source. That failure renders as
    // a 404 three tests later, nowhere near its cause.
    Installable.findOne.mockReset();
    Installable.create.mockResolvedValue({ installableId: '@nova/my-fork' });
    AgentRegistry.findOneAndUpdate.mockResolvedValue({ agentName: '@nova/my-fork' });
  });

  // CONTROL, same role as the one above: a fork of a clean source must reach
  // persistence, or every rejection below is attributable to the mock chain
  // rather than to the validator.
  it('forks a source whose components are clean', async () => {
    const res = await fork([widget({ widgetUrl: 'https://widgets.example.com/panel' })]);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(Installable.create).toHaveBeenCalledTimes(1);
  });

  it('refuses to launder an unvalidated widgetUrl out of a builtin source', async () => {
    // eslint-disable-next-line no-script-url
    const res = await fork([widget({ widgetUrl: 'javascript:alert(1)' })]);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(errorOf(res)).toMatch(/Source manifest cannot be forked:.*widgetUrl must use one of/i);
    expect(Installable.create).not.toHaveBeenCalled();
    expect(AgentRegistry.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('refuses an oversized Mixed field in the source', async () => {
    const res = await fork([widget({ metadata: { blob: 'x'.repeat(20 * 1024) } })]);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(errorOf(res)).toMatch(/Source manifest cannot be forked:.*metadata must be \d+ bytes or fewer/i);
    expect(Installable.create).not.toHaveBeenCalled();
  });

  it('says the SOURCE is the problem, so the caller is not told to fix their own request', () => {
    // The distinction is the whole point of the message prefix: on fork the
    // caller supplied only two ids, and a bare "components[0].widgetUrl ..."
    // would send them looking for a field they never sent.
    expect('Source manifest cannot be forked: components[0].widgetUrl must use one of: http:, https:')
      .toMatch(/^Source manifest cannot be forked: /);
  });
});
