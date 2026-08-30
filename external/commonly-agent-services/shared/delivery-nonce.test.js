const test = require('node:test');
const assert = require('node:assert/strict');
const { ackBodyForEvent } = require('./delivery-nonce');

test('uses the delivery nonce from the claimed event payload', () => {
  assert.deepEqual(ackBodyForEvent({ payload: { deliveryId: 'claimed-child' } }), {
    deliveryId: 'claimed-child',
  });
});

test('does not invent a nonce for a pre-D6 event', () => {
  assert.deepEqual(ackBodyForEvent({ payload: {} }), {});
  assert.deepEqual(ackBodyForEvent(undefined), {});
});
