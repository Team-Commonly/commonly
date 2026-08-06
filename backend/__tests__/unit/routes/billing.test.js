/**
 * /api/billing routes.
 *
 * The security boundary here is the webhook signature: that endpoint has NO
 * auth middleware because Stripe is the caller, so the signature is the only
 * thing standing between a stranger and a free Pro subscription. It gets the
 * most tests.
 */

const express = require('express');
const request = require('supertest');

jest.mock('express-rate-limit', () => {
  const factory = () => (_req, _res, next) => next();
  factory.default = factory;
  factory.ipKeyGenerator = (ip) => ip;
  return factory;
});

jest.mock('../../../middleware/auth', () => (req, _res, next) => { req.userId = 'u-1'; next(); });

// `mock`-prefixed so jest's hoisted factories may reference them.
const mockSave = jest.fn();
const mockCurrentUser = { value: null };
jest.mock('../../../models/User', () => ({
  findById: jest.fn(() => Promise.resolve(mockCurrentUser.value)),
}));

const mockConstructEvent = jest.fn();
const mockSessionsCreate = jest.fn();
const mockCustomersCreate = jest.fn();
const mockPortalCreate = jest.fn();
const mockHandleEvent = jest.fn();

jest.mock('../../../services/billingService', () => ({
  STRIPE_ENABLED: () => Boolean(process.env.STRIPE_SECRET_KEY),
  stripe: () => ({
    webhooks: { constructEvent: mockConstructEvent },
    checkout: { sessions: { create: mockSessionsCreate } },
    customers: { create: mockCustomersCreate },
    billingPortal: { sessions: { create: mockPortalCreate } },
  }),
  handleEvent: mockHandleEvent,
}));

const app = express();
// Mirrors server.ts: raw for the webhook, JSON for everything else.
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use('/api/billing', require('../../../routes/billing'));

const ORIGINAL_ENV = process.env;

describe('/api/billing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV, STRIPE_SECRET_KEY: 'sk_test', STRIPE_PRICE_ID: 'price_1', STRIPE_WEBHOOK_SECRET: 'whsec' };
    mockSave.mockResolvedValue(undefined);
    mockCurrentUser.value = { _id: 'u-1', email: 'a@b.c', isBot: false, billing: { customerId: 'cus_1' }, save: mockSave };
    mockSessionsCreate.mockResolvedValue({ url: 'https://checkout.stripe.test/s/1' });
    mockPortalCreate.mockResolvedValue({ url: 'https://billing.stripe.test/p/1' });
    mockHandleEvent.mockResolvedValue({ outcome: 'applied' });
  });
  afterAll(() => { process.env = ORIGINAL_ENV; });

  describe('POST /webhook — the signature IS the authentication', () => {
    test('a bad signature is rejected and nothing is handled', async () => {
      mockConstructEvent.mockImplementation(() => { throw new Error('no signatures found'); });
      const res = await request(app).post('/api/billing/webhook')
        .set('stripe-signature', 'forged')
        .set('Content-Type', 'application/json')
        .send(Buffer.from(JSON.stringify({ type: 'customer.subscription.updated' })));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_signature');
      expect(mockHandleEvent).not.toHaveBeenCalled();
    });

    test('a missing signature header is rejected', async () => {
      mockConstructEvent.mockImplementation(() => { throw new Error('missing header'); });
      const res = await request(app).post('/api/billing/webhook')
        .set('Content-Type', 'application/json')
        .send(Buffer.from('{}'));
      expect(res.status).toBe(400);
      expect(mockHandleEvent).not.toHaveBeenCalled();
    });

    // The classic breakage: verification needs the exact bytes, so the handler
    // must receive a Buffer, not a parsed object.
    test('the handler is given the RAW body, not parsed JSON', async () => {
      mockConstructEvent.mockReturnValue({ id: 'evt_1', type: 'x', data: { object: {} } });
      await request(app).post('/api/billing/webhook')
        .set('stripe-signature', 'sig')
        .set('Content-Type', 'application/json')
        .send(Buffer.from(JSON.stringify({ hello: 'world' })));
      expect(Buffer.isBuffer(mockConstructEvent.mock.calls[0][0])).toBe(true);
    });

    test('a verified event is handled and acknowledged 200', async () => {
      mockConstructEvent.mockReturnValue({ id: 'evt_1', type: 'checkout.session.completed', data: { object: {} } });
      const res = await request(app).post('/api/billing/webhook')
        .set('stripe-signature', 'sig')
        .set('Content-Type', 'application/json')
        .send(Buffer.from('{}'));
      expect(res.status).toBe(200);
      expect(mockHandleEvent).toHaveBeenCalled();
    });

    // A non-2xx makes Stripe retry for three days. An event we deliberately
    // ignored must still be acknowledged or we cause our own retry storm.
    test('an ignored event still returns 200', async () => {
      mockConstructEvent.mockReturnValue({ id: 'evt_2', type: 'invoice.created', data: { object: {} } });
      mockHandleEvent.mockResolvedValue({ outcome: 'ignored' });
      const res = await request(app).post('/api/billing/webhook')
        .set('stripe-signature', 'sig').set('Content-Type', 'application/json').send(Buffer.from('{}'));
      expect(res.status).toBe(200);
    });

    // ...but a genuine handler failure SHOULD retry.
    test('a handler exception returns 500 so Stripe retries', async () => {
      mockConstructEvent.mockReturnValue({ id: 'evt_3', type: 'x', data: { object: {} } });
      mockHandleEvent.mockRejectedValue(new Error('mongo down'));
      const res = await request(app).post('/api/billing/webhook')
        .set('stripe-signature', 'sig').set('Content-Type', 'application/json').send(Buffer.from('{}'));
      expect(res.status).toBe(500);
    });

    test('unconfigured billing refuses rather than half-working', async () => {
      delete process.env.STRIPE_WEBHOOK_SECRET;
      const res = await request(app).post('/api/billing/webhook')
        .set('stripe-signature', 'sig').set('Content-Type', 'application/json').send(Buffer.from('{}'));
      expect(res.status).toBe(503);
    });
  });

  describe('POST /checkout', () => {
    test('returns a Checkout url and grants nothing', async () => {
      const res = await request(app).post('/api/billing/checkout').send({});
      expect(res.status).toBe(200);
      expect(res.body.url).toContain('checkout.stripe.test');
      // Entitlement must come from the webhook only.
      expect(mockCurrentUser.value.entitlements).toBeUndefined();
    });

    test('creates and stamps a customer id before redirecting', async () => {
      mockCurrentUser.value = { _id: 'u-1', email: 'a@b.c', isBot: false, save: mockSave };
      mockCustomersCreate.mockResolvedValue({ id: 'cus_new' });
      await request(app).post('/api/billing/checkout').send({});
      expect(mockCurrentUser.value.billing.customerId).toBe('cus_new');
      expect(mockSave).toHaveBeenCalled();
    });

    test('carries the user id both ways so the webhook can always resolve it', async () => {
      await request(app).post('/api/billing/checkout').send({});
      const arg = mockSessionsCreate.mock.calls[0][0];
      expect(arg.client_reference_id).toBe('u-1');
      expect(arg.metadata.userId).toBe('u-1');
      expect(arg.subscription_data.metadata.userId).toBe('u-1');
    });

    // A customer created under test keys does not exist under live ones. This
    // is not hypothetical: the first checkout after the 2026-08-06 test -> live
    // cutover named a customer Stripe had never heard of.
    describe('a stored customer id Stripe does not recognise', () => {
      const missingCustomer = () => Object.assign(new Error("No such customer: 'cus_gone'"), {
        code: 'resource_missing', param: 'customer',
      });

      test('is replaced and the checkout succeeds', async () => {
        mockSessionsCreate
          .mockRejectedValueOnce(missingCustomer())
          .mockResolvedValueOnce({ url: 'https://checkout.stripe.test/s/2' });
        mockCustomersCreate.mockResolvedValue({ id: 'cus_fresh' });

        const res = await request(app).post('/api/billing/checkout').send({});
        expect(res.status).toBe(200);
        expect(res.body.url).toContain('/s/2');
        expect(mockCurrentUser.value.billing.customerId).toBe('cus_fresh');
        // The retry must use the NEW id, or it fails identically.
        expect(mockSessionsCreate.mock.calls[1][0].customer).toBe('cus_fresh');
      });

      test('is retried exactly once, never in a loop', async () => {
        mockSessionsCreate.mockRejectedValue(missingCustomer());
        mockCustomersCreate.mockResolvedValue({ id: 'cus_fresh' });

        const res = await request(app).post('/api/billing/checkout').send({});
        expect(res.status).toBe(500);
        expect(mockSessionsCreate).toHaveBeenCalledTimes(2);
        expect(mockCustomersCreate).toHaveBeenCalledTimes(1);
      });

      // The dangerous false positive: a half-finished cutover leaves a TEST
      // price id against LIVE keys, which also raises resource_missing. Minting
      // a new customer for that would churn customers and still fail.
      test('a missing PRICE is not mistaken for a stale customer', async () => {
        mockSessionsCreate.mockRejectedValue(Object.assign(new Error('No such price'), {
          code: 'resource_missing', param: 'line_items[0][price]',
        }));
        const res = await request(app).post('/api/billing/checkout').send({});
        expect(res.status).toBe(500);
        expect(mockCustomersCreate).not.toHaveBeenCalled();
        expect(mockSessionsCreate).toHaveBeenCalledTimes(1);
      });

      test('the portal reports no_subscription rather than 500', async () => {
        mockPortalCreate.mockRejectedValue(missingCustomer());
        const res = await request(app).post('/api/billing/portal').send({});
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('no_subscription');
        // Never silently mint a customer here — the portal would open empty.
        expect(mockCustomersCreate).not.toHaveBeenCalled();
      });
    });

    test('agents cannot subscribe', async () => {
      mockCurrentUser.value = { _id: 'b-1', isBot: true, save: mockSave };
      const res = await request(app).post('/api/billing/checkout').send({});
      expect(res.status).toBe(400);
      expect(mockSessionsCreate).not.toHaveBeenCalled();
    });

    test('missing price config refuses rather than creating a broken session', async () => {
      delete process.env.STRIPE_PRICE_ID;
      const res = await request(app).post('/api/billing/checkout').send({});
      expect(res.status).toBe(503);
      expect(mockSessionsCreate).not.toHaveBeenCalled();
    });
  });

  describe('POST /portal — the exit must always work', () => {
    test('returns a portal url', async () => {
      const res = await request(app).post('/api/billing/portal').send({});
      expect(res.status).toBe(200);
      expect(res.body.url).toContain('billing.stripe.test');
    });

    test('a user who never subscribed gets a clear error, not a crash', async () => {
      mockCurrentUser.value = { _id: 'u-1', save: mockSave };
      const res = await request(app).post('/api/billing/portal').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('no_subscription');
    });
  });
});
