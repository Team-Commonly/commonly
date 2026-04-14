/**
 * ObjectStore singleton — resolves the configured driver at first access.
 *
 * Driver selection via env:
 *   OBJECT_STORE_DRIVER=mongo   (default — no setup needed)
 *
 * Additional drivers (filesystem, gcs, s3) land in later ADR-002 phases.
 */

import type { ObjectStore } from './ObjectStore';
import { MongoObjectStore } from './drivers/mongoDriver';

export type { ObjectStore, ObjectStoreCapabilities, StoredObject } from './ObjectStore';

let instance: ObjectStore | null = null;

function buildDriver(): ObjectStore {
  const driverName = (process.env.OBJECT_STORE_DRIVER || 'mongo').toLowerCase();
  switch (driverName) {
    case 'mongo':
      return new MongoObjectStore();
    default:
      throw new Error(
        `OBJECT_STORE_DRIVER="${driverName}" is not supported. ` +
          'Phase 1 ships only: mongo. See ADR-002 for later phases.',
      );
  }
}

/** Returns the configured ObjectStore, building it on first call. */
export function getObjectStore(): ObjectStore {
  if (!instance) instance = buildDriver();
  return instance;
}

/** Test-only: reset the cached instance so env changes take effect. */
export function __resetObjectStoreForTests(): void {
  instance = null;
}
