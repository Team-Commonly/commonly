const test = require('node:test');
const assert = require('node:assert/strict');
const { ackBodyForEvent } = require('./delivery-nonce');
const BridgeBase = require('./bridge-base');

test('uses the delivery nonce from the claimed event payload', () => {
  assert.deepEqual(ackBodyForEvent({ payload: { deliveryId: 'claimed-child' } }), {
    deliveryId: 'claimed-child',
  });
});

test('does not invent a nonce for a pre-D6 event', () => {
  assert.deepEqual(ackBodyForEvent({ payload: {} }), {});
  assert.deepEqual(ackBodyForEvent(undefined), {});
});

test('the generic bridge echoes the claimed nonce on its ack wire call', async () => {
  const previousFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true };
  };

  try {
    const bridge = new BridgeBase({ baseUrl: 'https://api.example', agentToken: 'cm_agent_test' });
    await bridge.ackEvent('evt-1', 'claimed-child');
    assert.equal(request.url, 'https://api.example/api/agents/runtime/events/evt-1/ack');
    assert.deepEqual(JSON.parse(request.options.body), { deliveryId: 'claimed-child' });
  } finally {
    global.fetch = previousFetch;
  }
});

test('the generic bridge keeps the Phase-A empty body for a legacy event', async () => {
  const previousFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true };
  };

  try {
    const bridge = new BridgeBase({ baseUrl: 'https://api.example', agentToken: 'cm_agent_test' });
    await bridge.ackEvent('legacy-event');
    assert.deepEqual(JSON.parse(request.options.body), {});
  } finally {
    global.fetch = previousFetch;
  }
});
