// @ts-nocheck
// ADR-002 Phase 1: driver selection via OBJECT_STORE_DRIVER env.

const { getObjectStore, __resetObjectStoreForTests } = require('../../../../services/objectStore');

describe('getObjectStore (ADR-002 Phase 1 driver selection)', () => {
  const ORIGINAL_ENV = process.env;

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    __resetObjectStoreForTests();
  });

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.OBJECT_STORE_DRIVER;
    __resetObjectStoreForTests();
  });

  it('defaults to the mongo driver when OBJECT_STORE_DRIVER is unset', () => {
    const store = getObjectStore();
    expect(store.capabilities.name).toBe('mongo');
  });

  it('rejects unknown drivers with a clear error', () => {
    process.env.OBJECT_STORE_DRIVER = 'unicorn';
    expect(() => getObjectStore()).toThrow(/unicorn.*not supported/);
  });

  it('caches the resolved driver across calls', () => {
    const a = getObjectStore();
    const b = getObjectStore();
    expect(a).toBe(b);
  });
});
