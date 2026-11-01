import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'crypto';
import { Types } from 'mongoose';

import type { IConnectorSecret } from '../models/ConnectorSecret';
import type { ConnectorSecretKindSpec } from './connectorSecretKinds';

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const ConnectorSecret = require('../models/ConnectorSecret');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

interface KeyRing {
  activeKeyId: string;
  keys: Map<string, Buffer>;
}

export class ConnectorSecretKeyMissing extends Error {
  code = 'connector_secret_key_missing';

  constructor(keyId: string) {
    super(`Connector secret key '${keyId}' is not available in the active key ring.`);
    this.name = 'ConnectorSecretKeyMissing';
  }
}

export class ConnectorSecretConfigurationError extends Error {
  code = 'connector_secret_configuration_invalid';

  constructor(message: string) {
    super(message);
    this.name = 'ConnectorSecretConfigurationError';
  }
}

export class ConnectorSecretNotFoundError extends Error {
  code = 'connector_secret_not_found';

  constructor(ref: string) {
    super(`Connector secret '${ref}' was not found.`);
    this.name = 'ConnectorSecretNotFoundError';
  }
}

const parseKeyRing = (): KeyRing => {
  const serialized = process.env.CONNECTOR_SECRET_KEYS;
  const activeKeyId = process.env.CONNECTOR_SECRET_ACTIVE_KEY;
  if (!serialized || !activeKeyId) {
    throw new ConnectorSecretConfigurationError(
      'CONNECTOR_SECRET_KEYS and CONNECTOR_SECRET_ACTIVE_KEY must both be configured.',
    );
  }

  const keys = new Map<string, Buffer>();
  for (const entry of serialized.split(',')) {
    const separator = entry.indexOf(':');
    if (separator <= 0 || separator === entry.length - 1) {
      throw new ConnectorSecretConfigurationError('Each connector secret key must be keyId:base64Key.');
    }
    const keyId = entry.slice(0, separator).trim();
    const encodedKey = entry.slice(separator + 1).trim();
    const key = Buffer.from(encodedKey, 'base64');
    if (!keyId || key.length !== 32) {
      throw new ConnectorSecretConfigurationError(
        `Connector secret key '${keyId || '(missing)'}' must decode to exactly 32 bytes.`,
      );
    }
    if (keys.has(keyId)) {
      throw new ConnectorSecretConfigurationError(`Connector secret key '${keyId}' is duplicated.`);
    }
    keys.set(keyId, key);
  }
  if (!keys.has(activeKeyId)) throw new ConnectorSecretKeyMissing(activeKeyId);
  return { activeKeyId, keys };
};

const getKey = (ring: KeyRing, keyId: string): Buffer => {
  const key = ring.keys.get(keyId);
  if (!key) throw new ConnectorSecretKeyMissing(keyId);
  return key;
};

const encrypt = (material: string, ring: KeyRing): Pick<IConnectorSecret, 'ciphertext' | 'iv' | 'tag' | 'keyId'> => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, getKey(ring, ring.activeKeyId), iv);
  const ciphertext = Buffer.concat([cipher.update(material, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    keyId: ring.activeKeyId,
  };
};

const decrypt = (secret: Pick<IConnectorSecret, 'ciphertext' | 'iv' | 'tag' | 'keyId'>, ring: KeyRing): string => {
  const decipher = createDecipheriv(ALGORITHM, getKey(ring, secret.keyId), Buffer.from(secret.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(secret.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(secret.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
};

const asObjectId = (integrationId: string): Types.ObjectId => {
  if (!Types.ObjectId.isValid(integrationId)) {
    throw new ConnectorSecretConfigurationError('integrationId must be a valid ObjectId.');
  }
  return new Types.ObjectId(integrationId);
};

const upsertEncrypted = async (
  integrationId: Types.ObjectId,
  spec: ConnectorSecretKindSpec,
  encrypted: Pick<IConnectorSecret, 'ciphertext' | 'iv' | 'tag' | 'keyId'>,
  writeGeneration?: number,
): Promise<IConnectorSecret> => {
  // The filter carries `kind` as well as `integrationId`, on BOTH the upsert and
  // the retry. Filtered on `integrationId` alone the second kind does not
  // collide — it MATCHES the first kind's row and $sets this ciphertext onto it,
  // so the first ref stays valid and silently starts decrypting to the second
  // secret. `kind` is read from the caller's spec, and the index in
  // `models/ConnectorSecret` is on the same pair.
  const filter = writeGeneration === undefined
    ? { integrationId, kind: spec.kind }
    : {
      integrationId,
      kind: spec.kind,
      $or: [
        { writeGeneration: { $exists: false } },
        { writeGeneration: { $lte: writeGeneration } },
      ],
    };
  const update = {
    $set: { provider: spec.provider, ...encrypted, ...(writeGeneration === undefined ? {} : { writeGeneration }) },
  };
  try {
    return await ConnectorSecret.findOneAndUpdate(
      filter,
      update,
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ) as IConnectorSecret;
  } catch (error) {
    // Concurrent OAuth callbacks may race the first upsert. The unique
    // (integrationId, kind) key makes the loser retry as an ordinary update.
    if ((error as { code?: number }).code !== 11000) throw error;
    const retried = await ConnectorSecret.findOneAndUpdate(filter, update, { new: true }) as IConnectorSecret | null;
    if (!retried) throw new ConnectorSecretStaleWrite();
    return retried;
  }
};

export class ConnectorSecretStaleWrite extends Error {
  constructor() {
    super('A newer connector authorization owns this secret.');
    this.name = 'ConnectorSecretStaleWrite';
  }
}

export const put = async (
  integrationId: string,
  spec: ConnectorSecretKindSpec,
  material: string,
  writeGeneration?: number,
): Promise<string> => {
  if (!material) throw new ConnectorSecretConfigurationError('Connector secret material must not be empty.');
  const secret = await upsertEncrypted(
    asObjectId(integrationId), spec, encrypt(material, parseKeyRing()), writeGeneration,
  );
  return String(secret._id);
};

/**
 * Store `material` only if `(integrationId, kind)` has no secret yet. Returns
 * the ref and whether this call created it. A migration that imports an old
 * plaintext copy uses this, so it never overwrites a secret a live writer stored
 * after the migration read the row (TASK-539, CodeRabbit on #3004). On a
 * conflict the existing secret wins and its ref is returned unchanged.
 */
export const putIfAbsent = async (
  integrationId: string,
  spec: ConnectorSecretKindSpec,
  material: string,
): Promise<{ ref: string; created: boolean }> => {
  if (!material) throw new ConnectorSecretConfigurationError('Connector secret material must not be empty.');
  const id = asObjectId(integrationId);
  const encrypted = encrypt(material, parseKeyRing());
  try {
    const secret = await ConnectorSecret.create({
      integrationId: id, kind: spec.kind, provider: spec.provider, ...encrypted,
    }) as IConnectorSecret;
    return { ref: String(secret._id), created: true };
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    const existing = await ConnectorSecret.findOne({ integrationId: id, kind: spec.kind }) as IConnectorSecret | null;
    if (!existing) throw error;
    return { ref: String(existing._id), created: false };
  }
};

export const get = async (ref: string): Promise<string> => {
  const secret = await ConnectorSecret.findById(ref) as IConnectorSecret | null;
  if (!secret) throw new ConnectorSecretNotFoundError(ref);
  return decrypt(secret, parseKeyRing());
};

/**
 * The write generation the material behind `ref` was stored at, or null for a
 * secret stored without one. A writer puts both halves of a token pair at ONE
 * generation, so halves that disagree came from two writes, and the second of
 * them stopped between its puts (F35). Reads no material.
 */
export const writeGenerationOf = async (ref: string): Promise<number | null> => {
  const secret = await ConnectorSecret.findById(ref).select('writeGeneration').lean() as
    Pick<IConnectorSecret, 'writeGeneration'> | null;
  if (!secret) throw new ConnectorSecretNotFoundError(ref);
  return typeof secret.writeGeneration === 'number' ? secret.writeGeneration : null;
};

export const revoke = async (ref: string | undefined): Promise<void> => {
  if (!ref) return;
  await ConnectorSecret.deleteOne({ _id: ref });
};

/**
 * Delete a secret only while it still holds the material `writeGeneration`
 * wrote. For a writer cleaning up after itself: the ref is stable per
 * (integration, kind), so a newer writer may already own it, and a delete by
 * ref alone would destroy that writer's key.
 */
export const revokeOwnWrite = async (ref: string | undefined, writeGeneration: number): Promise<void> => {
  if (!ref) return;
  await ConnectorSecret.deleteOne({ _id: ref, writeGeneration });
};

export const rewrap = async (ref: string): Promise<string> => {
  const secret = await ConnectorSecret.findById(ref) as IConnectorSecret | null;
  if (!secret) throw new ConnectorSecretNotFoundError(ref);
  const ring = parseKeyRing();
  if (secret.keyId === ring.activeKeyId) return String(secret._id);
  const encrypted = encrypt(decrypt(secret, ring), ring);
  await ConnectorSecret.updateOne({ _id: secret._id, keyId: secret.keyId }, { $set: encrypted });
  return String(secret._id);
};

export const listWithUnavailableKey = async (): Promise<IConnectorSecret[]> => {
  const { keys } = parseKeyRing();
  return ConnectorSecret.find({ keyId: { $nin: [...keys.keys()] } }) as Promise<IConnectorSecret[]>;
};

module.exports = {
  ConnectorSecretKeyMissing,
  ConnectorSecretConfigurationError,
  ConnectorSecretNotFoundError,
  ConnectorSecretStaleWrite,
  put,
  putIfAbsent,
  get,
  writeGenerationOf,
  revoke,
  revokeOwnWrite,
  rewrap,
  listWithUnavailableKey,
};
