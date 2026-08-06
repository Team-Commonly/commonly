import rateLimit from 'express-rate-limit';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const express = require('express');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const auth = require('../middleware/auth');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const User = require('../models/User');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const billingService = require('../services/billingService');

const router = express.Router();

const checkoutLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

const FRONTEND = () => process.env.FRONTEND_URL || 'https://commonly.me';

/**
 * Did Stripe reject the request because the CUSTOMER we named does not exist?
 *
 * `billing.customerId` is a cache of a Stripe-side object, not identity — and
 * the two can diverge. A customer created under test keys does not exist under
 * live ones, so the first checkout after a test -> live cutover names a ghost;
 * the same happens if a customer is deleted in the dashboard or the account is
 * migrated. Without this the user gets `checkout_failed` forever, with no
 * recovery short of a database edit.
 *
 * `param` is what makes this safe to act on. `resource_missing` also fires for
 * a missing PRICE — which is exactly what a half-finished cutover produces —
 * and treating that as a stale customer would churn out a new Stripe customer
 * on every attempt while still failing. Only `param === 'customer'` is ours.
 */
const isMissingCustomer = (err: any): boolean => {
  const e = err?.raw || err;
  return e?.code === 'resource_missing' && e?.param === 'customer';
};

/** Create a Stripe customer for this user and persist the id. */
const attachCustomer = async (stripe: any, user: any): Promise<string> => {
  const customer = await stripe.customers.create({
    email: user.email,
    metadata: { userId: String(user._id), username: user.username || '' },
  });
  user.billing = { ...(user.billing || {}), customerId: customer.id };
  await user.save();
  return customer.id;
};

/**
 * POST /api/billing/checkout — start a subscription.
 *
 * Creates (or reuses) a Stripe customer, stamps `billing.customerId` BEFORE
 * redirecting, and returns the Checkout URL. Stamping first matters: if the
 * user pays and the `checkout.session.completed` metadata is somehow absent,
 * the customer id is still a valid join key back to this account.
 *
 * Grants nothing. Only the webhook does.
 */
router.post('/checkout', checkoutLimit, auth, async (req: any, res: any) => {
  try {
    if (!billingService.STRIPE_ENABLED()) {
      return res.status(503).json({ error: 'billing_not_configured' });
    }
    const priceId = process.env.STRIPE_PRICE_ID;
    if (!priceId) return res.status(503).json({ error: 'billing_not_configured' });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.isBot) return res.status(400).json({ error: 'Agents do not hold subscriptions' });

    const stripe = billingService.stripe();
    let customerId = user.billing?.customerId || await attachCustomer(stripe, user);

    // No `automatic_tax` on purpose. Stripe Tax is not activated on the
    // account, and enabling it here would fail session creation outright.
    // The price is configured `tax_behavior: inclusive`, so the customer pays
    // exactly the advertised $12 whether or not tax is ever calculated —
    // turning Stripe Tax on later changes what we remit, never the sticker
    // price. Enabling it also requires `customer_update: { address: 'auto' }`,
    // since an existing customer needs an address before tax can be computed.
    const openSession = (customer: string) => stripe.checkout.sessions.create({
      mode: 'subscription',
      customer,
      line_items: [{ price: priceId, quantity: 1 }],
      // Both, deliberately: `client_reference_id` survives places metadata does
      // not, and the webhook reads either.
      client_reference_id: String(user._id),
      subscription_data: { metadata: { userId: String(user._id) } },
      metadata: { userId: String(user._id) },
      success_url: `${FRONTEND()}/v2/settings?upgraded=1`,
      cancel_url: `${FRONTEND()}/v2/settings?upgrade=cancelled`,
      allow_promotion_codes: true,
    });

    let session;
    try {
      session = await openSession(customerId);
    } catch (err) {
      if (!isMissingCustomer(err)) throw err;
      // Stale id — re-attach and retry ONCE. A second failure is not staleness,
      // and must surface rather than loop.
      console.warn('[billing] stored customer id unknown to Stripe; re-creating');
      customerId = await attachCustomer(stripe, user);
      session = await openSession(customerId);
    }

    return res.json({ url: session.url });
  } catch (err) {
    console.error('[billing] checkout failed:', (err as Error).message);
    return res.status(500).json({ error: 'checkout_failed' });
  }
});

/**
 * POST /api/billing/portal — manage or cancel.
 *
 * Self-serve cancellation is not a nicety: without it every downgrade becomes
 * a support email, and a user who cannot find the exit disputes the charge
 * instead.
 */
router.post('/portal', checkoutLimit, auth, async (req: any, res: any) => {
  try {
    if (!billingService.STRIPE_ENABLED()) {
      return res.status(503).json({ error: 'billing_not_configured' });
    }
    const user = await User.findById(req.userId);
    const customerId = user?.billing?.customerId;
    if (!customerId) return res.status(400).json({ error: 'no_subscription' });

    const session = await billingService.stripe().billingPortal.sessions.create({
      customer: customerId,
      return_url: `${FRONTEND()}/v2/settings`,
    });
    return res.json({ url: session.url });
  } catch (err) {
    // Unlike checkout, a stale customer is NOT re-created here: a fresh
    // customer has no subscription, so the portal would open empty and imply
    // the subscription vanished. `no_subscription` is both true and
    // actionable — the UI tells them to subscribe.
    if (isMissingCustomer(err)) {
      console.warn('[billing] portal requested for a customer unknown to Stripe');
      return res.status(400).json({ error: 'no_subscription' });
    }
    console.error('[billing] portal failed:', (err as Error).message);
    return res.status(500).json({ error: 'portal_failed' });
  }
});

/**
 * POST /api/billing/webhook — the ONLY writer of entitlements.pro.
 *
 * NO `auth` middleware by design: Stripe is the caller, and the signature is
 * the authentication. Mounted with `express.raw` in server.ts before the
 * global JSON parser, because `constructEvent` needs the exact bytes — a
 * re-serialized body fails verification, which is the single most common way
 * this integration breaks.
 *
 * Returns 200 on anything we have durably recorded, including events we chose
 * to ignore. Returning non-2xx makes Stripe retry for three days, so a bug in
 * our handling would turn into a retry storm; only a signature failure or an
 * unrecorded error is worth a retry.
 */
router.post('/webhook', async (req: any, res: any) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!billingService.STRIPE_ENABLED() || !secret) {
    return res.status(503).json({ error: 'billing_not_configured' });
  }

  let event;
  try {
    event = billingService.stripe().webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      secret,
    );
  } catch (err) {
    // Never log the body — it is signed but not ours to spill.
    console.warn('[billing] webhook signature rejected:', (err as Error).message);
    return res.status(400).json({ error: 'invalid_signature' });
  }

  try {
    const result = await billingService.handleEvent(event);
    return res.json({ received: true, outcome: result.outcome });
  } catch (err) {
    console.error('[billing] webhook handling failed:', (err as Error).message);
    // Unrecorded failure — let Stripe retry.
    return res.status(500).json({ error: 'handler_failed' });
  }
});

module.exports = router;
