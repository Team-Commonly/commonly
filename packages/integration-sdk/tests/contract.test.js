// Lightweight contract test using Node's assert.
const assert = require('assert');
const { registry, IntegrationRegistry, handleVerifyToken, ValidationError } = require('../src');

// test registry basics
const mockFactory = (cfg) => ({ cfg });
const testRegistry = new IntegrationRegistry();
testRegistry.register('mock', mockFactory);
const instance = testRegistry.get('mock', { a: 1 });
assert.deepStrictEqual(instance.cfg, { a: 1 });

// test verify helper success
const verifyOk = handleVerifyToken({ 'hub.mode': 'subscribe', 'hub.verify_token': 't', 'hub.challenge': '123' }, 't');
assert.strictEqual(verifyOk.status, 200);
assert.strictEqual(verifyOk.body, '123');

// test verify helper failure
let threw = false;
try {
  handleVerifyToken({ 'hub.mode': 'subscribe', 'hub.verify_token': 'bad', 'hub.challenge': 'x' }, 't');
} catch (err) {
  threw = err instanceof ValidationError;
}
assert.ok(threw, 'handleVerifyToken should throw ValidationError on mismatch');

// test default singleton registry
registry.register('singleton-mock', mockFactory);
const singletonInstance = registry.get('singleton-mock', { foo: 'bar' });
assert.strictEqual(singletonInstance.cfg.foo, 'bar');

console.log('integration-sdk contract tests passed');
