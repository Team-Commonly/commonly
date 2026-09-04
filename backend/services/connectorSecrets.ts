import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'crypto';
import { Types } from 'mongoose';

import type { IConnectorSecret } from '../models/ConnectorSecret';

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
  provider: string,
  encrypted: Pick<IConnectorSecret, 'ciphertext' | 'iv' | 'tag' | 'keyId'>,
): Promise<IConnectorSecret> => {
  try {
    return await ConnectorSecret.findOneAndUpdate(
      { integrationId },
      { $set: { provider, ...encrypted } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ) as IConnectorSecret;
  } catch (error) {
    // Concurrent OAuth callbacks may race the first upsert. The unique
    // integration key makes the loser retry as an ordinary update.
    if ((error as { code?: number }).code !== 11000) throw error;
    return ConnectorSecret.findOneAndUpdate(
      { integrationId },
      { $set: { provider, ...encrypted } },
      { new: true },
    ) as Promise<IConnectorSecret>;
  }
};

export const put = async (integrationId: string, provider: string, material: string): Promise<string> => {
  if (!material) throw new ConnectorSecretConfigurationError('Connector secret material must not be empty.');
  const secret = await upsertEncrypted(asObjectId(integrationId), provider, encrypt(material, parseKeyRing()));
  return String(secret._id);
};

export const get = async (ref: string): Promise<string> => {
  const secret = await ConnectorSecret.findById(ref) as IConnectorSecret | null;
  if (!secret) throw new ConnectorSecretNotFoundError(ref);
  return decrypt(secret, parseKeyRing());
};

export const revoke = async (ref: string | undefined): Promise<void> => {
  if (!ref) return;
  await ConnectorSecret.deleteOne({ _id: ref });
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
  put,
  get,
  revoke,
  rewrap,
  listWithUnavailableKey,
};
