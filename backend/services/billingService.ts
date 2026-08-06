/**
 * Stripe billing — the only writer of `entitlements.pro`.
 *
 * Design rules, each of which exists because the obvious alternative is a way
 * to lose money or give it away:
 *
 * 1. **The webhook is the only source of truth.** A client returning from
 *    Checkout proves nothing — the redirect is attacker-controllable and the
 *    session can be abandoned after redirect. Nothing in the success path
 *    grants Pro; only a signature-verified event does.
 *
 * 2. **Idempotent by durable marker.** Stripe retries for up to three days and
 *    guarantees neither once-only delivery nor ordering. `BillingEvent`'s
 *    unique index is the lock (see that model).
 *
 * 3. **Entitlement is derived from subscription status, never toggled.** Every
 *    handler recomputes `pro` from the status Stripe reports, so an
 *    out-of-order delivery converges instead of latching. `active` and
 *    `trialing` grant; everything else revokes.
 *
 * 4. **Grant on `checkout.session.completed` only when payment actually
 *    settled** (`payment_status === 'paid'`). A completed session with an
 *    async or failed payment is not money.
 */

import mongoose from 'mongoose';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Stripe = require('stripe');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const User = require('../models/User');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const BillingEvent = require('../models/BillingEvent');

export const STRIPE_ENABLED = (): boolean => Boolean(process.env.STRIPE_SECRET_KEY);

let cached: any = null;
export const stripe = (): any => {
  if (!STRIPE_ENABLED()) return null;
  if (!cached) cached = new Stripe(process.env.STRIPE_SECRET_KEY as string);
  return cached;
};

/** Statuses that mean the customer currently has what they paid for. */
const ENTITLED_STATUSES = new Set(['active', 'trialing']);

export const statusGrantsPro = (status?: string | null): boolean => (
  ENTITLED_STATUSES.has(String(status || ''))
);

interface ApplyArgs {
  customerId?: string | null;
  subscriptionId?: string | null;
  status?: string | null;
  currentPeriodEnd?: number | null;
  cancelAtPeriodEnd?: boolean | null;
  userIdHint?: string | null;
}

/**
 * Resolve the user and set their entitlement from the reported status.
 * Returns the outcome recorded on the BillingEvent row.
 */
export const applySubscriptionState = async ({
  customerId,
  subscriptionId,
  status,
  currentPeriodEnd,
  cancelAtPeriodEnd,
  userIdHint,
}: ApplyArgs): Promise<{ outcome: 'applied' | 'unmapped'; userId?: string; pro?: boolean }> => {
  let user: any = null;

  // Prefer the metadata hint (set at checkout creation) because it survives a
  // customer being recreated; fall back to the customer id, which is what
  // subscription lifecycle events carry.
  if (userIdHint && mongoose.Types.ObjectId.isValid(String(userIdHint))) {
    user = await User.findById(userIdHint);
  }
  if (!user && customerId) {
    user = await User.findOne({ 'billing.customerId': customerId });
  }
  if (!user) return { outcome: 'unmapped' };

  const pro = statusGrantsPro(status);

  user.entitlements = { ...(user.entitlements || {}), pro };
  user.billing = {
    ...(user.billing || {}),
    ...(customerId ? { customerId } : {}),
    ...(subscriptionId ? { subscriptionId } : {}),
    subscriptionStatus: status || undefined,
    currentPeriodEnd: currentPeriodEnd ? new Date(currentPeriodEnd * 1000) : user.billing?.currentPeriodEnd,
    cancelAtPeriodEnd: Boolean(cancelAtPeriodEnd),
  };
  await user.save();

  return { outcome: 'applied', userId: String(user._id), pro };
};

/**
 * Process one already-verified Stripe event. Caller must have checked the
 * signature — this function trusts its input by contract.
 */
export const handleEvent = async (event: any): Promise<{ outcome: string; detail?: string }> => {
  // Idempotency gate. The insert is the lock: a duplicate delivery loses the
  // unique index and returns without touching the user.
  try {
    await BillingEvent.create({
      eventId: event.id,
      type: event.type,
      outcome: 'ignored',
      detail: 'claimed',
    });
  } catch (err: any) {
    if (err?.code === 11000) return { outcome: 'duplicate' };
    throw err;
  }

  const obj = event?.data?.object || {};
  let result: { outcome: string; detail?: string; userId?: string } = { outcome: 'ignored' };

  switch (event.type) {
    case 'checkout.session.completed': {
      // Only money that actually settled. A completed session whose payment is
      // still processing (or failed) must not grant anything.
      if (obj.payment_status !== 'paid') {
        result = { outcome: 'ignored', detail: `payment_status=${obj.payment_status}` };
        break;
      }
      const applied = await applySubscriptionState({
        customerId: obj.customer,
        subscriptionId: obj.subscription,
        status: 'active',
        userIdHint: obj.metadata?.userId || obj.client_reference_id,
      });
      result = { ...applied, detail: 'checkout paid' };
      break;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      // `deleted` still carries a status ('canceled'), so the same derivation
      // handles all three — no special-casing, no latching.
      const applied = await applySubscriptionState({
        customerId: obj.customer,
        subscriptionId: obj.id,
        status: obj.status,
        currentPeriodEnd: obj.current_period_end,
        cancelAtPeriodEnd: obj.cancel_at_period_end,
        userIdHint: obj.metadata?.userId,
      });
      result = { ...applied, detail: `status=${obj.status}` };
      break;
    }

    default:
      result = { outcome: 'ignored', detail: 'unhandled type' };
  }

  await BillingEvent.updateOne(
    { eventId: event.id },
    {
      $set: {
        outcome: result.outcome === 'duplicate' ? 'ignored' : result.outcome,
        detail: result.detail,
        customerId: obj.customer || undefined,
        ...(result.userId ? { userId: result.userId } : {}),
      },
    },
  );

  return result;
};

export default { stripe, STRIPE_ENABLED, handleEvent, applySubscriptionState, statusGrantsPro };
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
