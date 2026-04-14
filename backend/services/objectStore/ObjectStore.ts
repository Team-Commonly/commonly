/**
 * ObjectStore — byte-storage abstraction for attachments (ADR-002).
 *
 * Drivers encapsulate *where the bytes live*. Metadata (uploadedBy,
 * originalName, sha256, etc.) lives on the parent entity (File in Phase 1,
 * Attachment/post/message in Phase 2+). A driver's job is narrow: put / get /
 * delete opaque bytes keyed by a string.
 *
 * The interface is intentionally narrow. Capabilities that only some drivers
 * support land as optional methods when a driver actually needs them — not
 * speculatively. In particular, Phase 3 (GCS) will add either an optional
 * `getSignedReadUrl(key, ttl)` method on this interface or a `redirectUrl`
 * field on `StoredObject`; the shape is deliberately deferred until the
 * driver exists and the route layer has a concrete caller to satisfy.
 */

export interface ObjectStoreCapabilities {
  /** Human-readable driver name; used in logs and /health. Open for
   *  extension — new drivers do not need to edit this file to register. */
  readonly name: string;
  /** Upper bound on a single object's byte size. Route layer uses this to
   *  size the multipart limit and emit 413 before bytes are buffered. */
  readonly maxObjectBytes: number;
}

export interface StoredObject {
  /** Readable stream of the object's bytes. */
  stream: NodeJS.ReadableStream;
  /** MIME type as supplied at `put` time. */
  mime: string;
  /** Byte length. */
  size: number;
}

export interface ObjectStore {
  readonly capabilities: ObjectStoreCapabilities;

  /**
   * Write bytes under `key`. Overwrites if the key exists. Throws on quota /
   * capacity errors so the route layer can return a useful status.
   */
  put(key: string, body: Buffer, mime: string): Promise<void>;

  /**
   * Read bytes by `key`. Returns `null` if the key does not exist — callers
   * should treat null as a 404, not an error.
   */
  get(key: string): Promise<StoredObject | null>;

  /** Remove bytes by `key`. No-op if the key does not exist. */
  delete(key: string): Promise<void>;
}
