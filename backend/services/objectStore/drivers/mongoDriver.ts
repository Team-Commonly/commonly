/**
 * Mongo driver for the ObjectStore (ADR-002 Phase 1).
 *
 * Writes bytes to the `MediaObject` collection. The legacy `File.data`
 * records are read by the route layer as a fallback for backward compat;
 * they are not managed by this driver.
 *
 * Default driver when `OBJECT_STORE_DRIVER` is unset — matches current dev
 * behavior and docker-compose.local.yml. Not suitable past hobbyist scale
 * (bytes in Mongo share IOPS with primary store). Cloud deployments
 * configure `gcs` in Phase 3.
 */

import { Readable } from 'stream';
import MediaObject from '../../../models/MediaObject';
import type { ObjectStore, ObjectStoreCapabilities, StoredObject } from '../ObjectStore';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB

export class MongoObjectStore implements ObjectStore {
  readonly capabilities: ObjectStoreCapabilities;

  constructor(maxObjectBytes: number = DEFAULT_MAX_BYTES) {
    this.capabilities = { name: 'mongo', maxObjectBytes };
  }

  async put(key: string, body: Buffer, mime: string): Promise<void> {
    await MediaObject.updateOne(
      { key },
      {
        $set: { data: body, mime, size: body.length },
        $setOnInsert: { key, createdAt: new Date() },
      },
      { upsert: true },
    );
  }

  async get(key: string): Promise<StoredObject | null> {
    const doc = await MediaObject.findByKey(key);
    if (!doc) return null;
    return {
      stream: Readable.from(doc.data),
      mime: doc.mime,
      size: doc.size,
    };
  }

  async delete(key: string): Promise<void> {
    await MediaObject.deleteOne({ key });
  }
}
