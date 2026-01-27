// Lightweight contract test using Node's assert.
const assert = require('assert');
const {
  registry,
  IntegrationRegistry,
  handleVerifyToken,
  ValidationError,
  buildConfigSchema,
  validateManifest,
  validateRequiredConfig,
  validateNormalizedMessage,
  IntegrationCatalog,
} = require('../src');

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

// manifest + required config validation
const manifest = validateManifest({
  id: 'mock-manifest',
  requiredConfig: ['token'],
  configSchema: buildConfigSchema(['token']),
  catalog: { label: 'Mock', category: 'test' },
});
validateRequiredConfig({ token: 'abc' }, manifest);
let missingRequiredThrew = false;
try {
  validateRequiredConfig({}, manifest);
} catch (err) {
  missingRequiredThrew = err instanceof ValidationError;
}
assert.ok(missingRequiredThrew, 'validateRequiredConfig should throw on missing fields');

// normalized message validation
const normalizedErrors = validateNormalizedMessage({
  source: 'mock',
  externalId: '1',
  authorId: 'a',
  authorName: 'A',
  content: 'hello',
  timestamp: new Date().toISOString(),
});
assert.deepStrictEqual(normalizedErrors, []);

// catalog registry
const testCatalog = new IntegrationCatalog();
testCatalog.register(manifest);
const catalogEntry = testCatalog.get('mock-manifest');
assert.ok(catalogEntry && catalogEntry.catalog.label === 'Mock');

console.log('integration-sdk contract tests passed');
