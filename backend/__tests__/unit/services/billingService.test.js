/**
 * billingService — the only writer of `entitlements.pro`.
 *
 * These tests exist because every bug here is either "we gave away the product"
 * or "we took money and withheld it". The four properties defended:
 *
 *   1. a replayed event never applies twice (Stripe retries for 3 days)
 *   2. entitlement is DERIVED from status, so out-of-order delivery converges
 *   3. an unsettled payment grants nothing
 *   4. an unmappable event is recorded, not silently dropped
 */

jest.mock('stripe', () => jest.fn(() => ({})));

const save = jest.fn();
const users = { byId: null, byCustomer: null };

jest.mock('../../../models/User', () => ({
  findById: jest.fn(() => Promise.resolve(users.byId)),
  findOne: jest.fn(() => Promise.resolve(users.byCustomer)),
}));

const created = [];
jest.mock('../../../models/BillingEvent', () => ({
  create: jest.fn((doc) => {
    if (created.some((d) => d.eventId === doc.eventId)) {
      const e = new Error('E11000 duplicate key');
      e.code = 11000;
      return Promise.reject(e);
    }
    created.push(doc);
    return Promise.resolve(doc);
  }),
  updateOne: jest.fn(() => Promise.resolve({})),
}));

const BillingEvent = require('../../../models/BillingEvent');
const { handleEvent, statusGrantsPro, applySubscriptionState } = require('../../../services/billingService');

const mkUser = (over = {}) => ({
  _id: 'u-1',
  email: 'a@b.c',
  entitlements: { cloudAgents: true, pro: false },
  billing: { customerId: 'cus_1' },
  save,
  ...over,
});

const evt = (type, object, id = `evt_${Math.random().toString(36).slice(2)}`) => ({
  id, type, data: { object },
});

describe('billingService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    created.length = 0;
    save.mockResolvedValue(undefined);
    users.byId = null;
    users.byCustomer = mkUser();
  });

  describe('entitlement is derived from status, never toggled', () => {
    test.each([['active', true], ['trialing', true], ['past_due', false],
      ['canceled', false], ['unpaid', false], ['incomplete', false], [undefined, false]])(
      'status %s grants pro = %s', (status, expected) => {
        expect(statusGrantsPro(status)).toBe(expected);
      },
    );

    // The property that makes out-of-order delivery safe: replaying an older
    // event recomputes from ITS status rather than flipping a toggle, so the
    // final write always matches the last event applied.
    test('an out-of-order revoke then re-grant converges, not latches', async () => {
      users.byCustomer = mkUser({ entitlements: { pro: true } });
      await handleEvent(evt('customer.subscription.updated', { customer: 'cus_1', id: 'sub_1', status: 'canceled' }));
      expect(users.byCustomer.entitlements.pro).toBe(false);

      await handleEvent(evt('customer.subscription.updated', { customer: 'cus_1', id: 'sub_1', status: 'active' }));
      expect(users.byCustomer.entitlements.pro).toBe(true);
    });
  });

  describe('idempotency — Stripe retries for three days', () => {
    test('a replayed event id is a no-op', async () => {
      const e = evt('customer.subscription.updated', { customer: 'cus_1', id: 'sub_1', status: 'active' }, 'evt_same');
      const first = await handleEvent(e);
      expect(first.outcome).toBe('applied');
      save.mockClear();

      const second = await handleEvent(e);
      expect(second.outcome).toBe('duplicate');
      expect(save).not.toHaveBeenCalled();
    });

    test('the marker is claimed BEFORE the user is touched', async () => {
      await handleEvent(evt('customer.subscription.updated', { customer: 'cus_1', id: 'sub_1', status: 'active' }));
      // If the write happened first, a crash between them would apply the
      // change with no record, and the retry would apply it again.
      expect(BillingEvent.create).toHaveBeenCalled();
      const claimOrder = BillingEvent.create.mock.invocationCallOrder[0];
      const saveOrder = save.mock.invocationCallOrder[0];
      expect(claimOrder).toBeLessThan(saveOrder);
    });
  });

  describe('checkout only grants when money actually settled', () => {
    test('payment_status=paid grants pro', async () => {
      const res = await handleEvent(evt('checkout.session.completed', {
        customer: 'cus_1', subscription: 'sub_1', payment_status: 'paid', metadata: { userId: 'u-1' },
      }));
      expect(res.outcome).toBe('applied');
      expect(users.byCustomer.entitlements.pro).toBe(true);
    });

    test.each(['unpaid', 'no_payment_required', undefined])(
      'payment_status=%s grants nothing', async (status) => {
        await handleEvent(evt('checkout.session.completed', {
          customer: 'cus_1', subscription: 'sub_1', payment_status: status,
        }));
        expect(save).not.toHaveBeenCalled();
      },
    );
  });

  describe('resolving the user', () => {
    test('prefers the metadata hint over the customer id', async () => {
      users.byId = mkUser({ _id: 'u-hint' });
      users.byCustomer = mkUser({ _id: 'u-wrong' });
      const res = await applySubscriptionState({
        customerId: 'cus_1', status: 'active', userIdHint: '507f1f77bcf86cd799439011',
      });
      expect(res.userId).toBe('u-hint');
    });

    test('falls back to customer id when there is no hint', async () => {
      const res = await applySubscriptionState({ customerId: 'cus_1', status: 'active' });
      expect(res.userId).toBe('u-1');
    });

    // An event we cannot map must be RECORDED, not dropped — otherwise a
    // paying customer with no access leaves no trace to debug.
    test('an unmappable event is reported as unmapped', async () => {
      users.byCustomer = null;
      const res = await handleEvent(evt('customer.subscription.updated', { customer: 'cus_ghost', status: 'active' }));
      expect(res.outcome).toBe('unmapped');
      expect(BillingEvent.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: expect.any(String) }),
        expect.objectContaining({ $set: expect.objectContaining({ outcome: 'unmapped' }) }),
      );
    });
  });

  describe('cancellation', () => {
    test('subscription.deleted revokes pro', async () => {
      users.byCustomer = mkUser({ entitlements: { cloudAgents: true, pro: true } });
      await handleEvent(evt('customer.subscription.deleted', { customer: 'cus_1', id: 'sub_1', status: 'canceled' }));
      expect(users.byCustomer.entitlements.pro).toBe(false);
    });

    // Losing Pro must not also lose hosted agents — separate entitlements.
    test('revoking pro leaves cloudAgents intact', async () => {
      users.byCustomer = mkUser({ entitlements: { cloudAgents: true, pro: true } });
      await handleEvent(evt('customer.subscription.deleted', { customer: 'cus_1', id: 'sub_1', status: 'canceled' }));
      expect(users.byCustomer.entitlements.cloudAgents).toBe(true);
    });

    test('cancel_at_period_end is recorded without revoking early', async () => {
      await handleEvent(evt('customer.subscription.updated', {
        customer: 'cus_1', id: 'sub_1', status: 'active', cancel_at_period_end: true,
        current_period_end: 1800000000,
      }));
      expect(users.byCustomer.entitlements.pro).toBe(true);
      expect(users.byCustomer.billing.cancelAtPeriodEnd).toBe(true);
      expect(users.byCustomer.billing.currentPeriodEnd).toEqual(new Date(1800000000 * 1000));
    });
  });

  test('an unhandled event type is ignored, not an error', async () => {
    const res = await handleEvent(evt('invoice.created', { customer: 'cus_1' }));
    expect(res.outcome).toBe('ignored');
    expect(save).not.toHaveBeenCalled();
  });
});
