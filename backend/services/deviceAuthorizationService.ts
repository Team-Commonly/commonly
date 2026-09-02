import crypto from 'crypto';
import { Types } from 'mongoose';
import DeviceAuthorization, { IDeviceAuthorization } from '../models/DeviceAuthorization';
import User from '../models/User';

export const DEVICE_AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
export const DEVICE_POLL_INTERVAL_SECONDS = 5;

const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const hashDeviceCredential = (value: string): string => crypto
  .createHash('sha256')
  .update(value)
  .digest('hex');

const randomUserCode = (): string => {
  // `randomInt` uses rejection sampling. Indexing random bytes with `%` is
  // biased whenever the alphabet length does not divide 256 (and CodeQL is
  // right not to make that safety depend on this alphabet's current length).
  const code = Array.from(
    { length: 8 },
    () => USER_CODE_ALPHABET[crypto.randomInt(USER_CODE_ALPHABET.length)],
  ).join('');
  return `${code.slice(0, 4)}-${code.slice(4)}`;
};

const randomDeviceToken = (): string => `cm_${crypto.randomBytes(32).toString('hex')}`;
const normalizeUserCode = (value: unknown): string => String(value || '')
  .trim()
  .toUpperCase()
  .replace(/[^A-Z2-9]/g, '');

const userCodeHash = (value: unknown): string | null => {
  const normalized = normalizeUserCode(value);
  return /^[A-HJ-NP-Z2-9]{8}$/.test(normalized) ? hashDeviceCredential(normalized) : null;
};

const isExpired = (request: IDeviceAuthorization, now = new Date()): boolean => request.expiresAt <= now;

export const createDeviceAuthorization = async ({
  clientName,
  clientVersion,
  hostname,
}: { clientName: unknown; clientVersion?: unknown; hostname: unknown }) => {
  const safeClientName = String(clientName || '').trim().slice(0, 120);
  const safeHostname = String(hostname || '').trim().slice(0, 253);
  const safeClientVersion = String(clientVersion || '').trim().slice(0, 80);
  if (!safeClientName || !safeHostname) throw new Error('clientName and hostname are required');

  // User-code collisions are very unlikely, but the unique index is the
  // source of truth; retry rather than risking an ambiguous browser approval.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const deviceCode = crypto.randomBytes(32).toString('base64url');
    const code = randomUserCode();
    try {
      await DeviceAuthorization.create({
        deviceCodeHash: hashDeviceCredential(deviceCode),
        userCodeHash: hashDeviceCredential(code.replace('-', '')),
        clientName: safeClientName,
        clientVersion: safeClientVersion || undefined,
        hostname: safeHostname,
        expiresAt: new Date(Date.now() + DEVICE_AUTHORIZATION_TTL_MS),
      });
      return { deviceCode, userCode: code };
    } catch (error: any) {
      if (error?.code !== 11000 || attempt === 4) throw error;
    }
  }
  throw new Error('Unable to create device authorization');
};

export const findDeviceAuthorizationByUserCode = async (value: unknown) => {
  const digest = userCodeHash(value);
  if (!digest) return null;
  return DeviceAuthorization.findOne({ userCodeHash: digest });
};

export const pollDeviceAuthorization = async (deviceCode: unknown) => {
  const raw = String(deviceCode || '').trim();
  if (!raw) return { status: 'invalid' as const };
  const request = await DeviceAuthorization.findOne({
    deviceCodeHash: hashDeviceCredential(raw),
  });
  if (!request) return { status: 'expired' as const };
  if (isExpired(request)) {
    return { status: 'expired' as const };
  }
  if (request.status === 'pending') {
    const now = new Date();
    const polledTooSoon = request.lastPolledAt
      && now.getTime() - request.lastPolledAt.getTime() < DEVICE_POLL_INTERVAL_SECONDS * 1000;
    await DeviceAuthorization.updateOne({ _id: request._id }, { $set: { lastPolledAt: now } });
    return { status: polledTooSoon ? 'slow_down' as const : 'authorization_pending' as const };
  }
  if (request.status === 'denied') return { status: 'denied' as const };
  if (request.status === 'consumed' || !request.userId) {
    return { status: 'already_used' as const };
  }

  // Conditional update prevents two concurrent polls from receiving the same
  // bearer, even if they read the approved request at the same time. Claim
  // before minting: if token persistence fails after this transition, the CLI
  // must re-run login rather than risk issuing a bearer twice.
  const claimed = await DeviceAuthorization.findOneAndUpdate(
    { _id: request._id, status: 'authorized', expiresAt: { $gt: new Date() } },
    { $set: { status: 'consumed', consumedAt: new Date() } },
    { new: false },
  );
  if (!claimed?.userId) return { status: 'already_used' as const };

  const token = randomDeviceToken();
  const user = await User.findOneAndUpdate(
    { _id: claimed.userId, banned: { $ne: true } },
    {
      $push: {
        deviceTokens: {
          tokenHash: hashDeviceCredential(token),
          label: `${claimed.hostname} · ${claimed.clientName}`,
          createdAt: new Date(),
        },
      },
    },
    { new: false, projection: '_id username' },
  );
  if (!user) return { status: 'denied' as const };
  return {
    status: 'authorized' as const,
    token,
    username: user.username,
    userId: user._id.toString(),
  };
};

export const decideDeviceAuthorization = async ({
  userCode,
  decision,
  userId,
}: { userCode: unknown; decision: unknown; userId: string }) => {
  const request = await findDeviceAuthorizationByUserCode(userCode);
  if (!request || isExpired(request)) return { status: 'expired' as const };
  if (request.status !== 'pending') return { status: request.status as 'authorized' | 'denied' | 'consumed' };

  const normalizedDecision = String(decision || '').toLowerCase();
  if (!normalizedDecision) {
    return {
      status: 'pending' as const,
      request: {
        hostname: request.hostname,
        clientName: request.clientName,
        clientVersion: request.clientVersion || null,
        createdAt: request.createdAt,
      },
    };
  }
  if (!['authorize', 'deny'].includes(normalizedDecision)) return { status: 'invalid_decision' as const };

  if (normalizedDecision === 'deny') {
    const denied = await DeviceAuthorization.findOneAndUpdate(
      { _id: request._id, status: 'pending', expiresAt: { $gt: new Date() } },
      { $set: { status: 'denied', deniedAt: new Date(), userId } },
      { new: true },
    );
    return denied ? { status: 'denied' as const } : { status: 'expired' as const };
  }

  const now = new Date();
  const authorized = await DeviceAuthorization.findOneAndUpdate(
    { _id: request._id, status: 'pending', expiresAt: { $gt: now } },
    { $set: { status: 'authorized', userId, authorizedAt: now } },
    { new: true },
  );
  return authorized ? { status: 'authorized' as const } : { status: 'expired' as const };
};

export const listDeviceTokens = async (userId: string) => {
  const user = await User.findById(userId).select('deviceTokens');
  return (user?.deviceTokens || []).map((entry: any) => ({
    id: entry._id.toString(),
    label: entry.label,
    createdAt: entry.createdAt,
    lastUsedAt: entry.lastUsedAt || null,
    revokedAt: entry.revokedAt || null,
  }));
};

export const revokeDeviceToken = async (userId: string, deviceId: string) => {
  if (!Types.ObjectId.isValid(deviceId)) return false;
  const result = await User.updateOne(
    {
      _id: userId,
      deviceTokens: { $elemMatch: { _id: deviceId, revokedAt: { $in: [null] } } },
    },
    { $set: { 'deviceTokens.$.revokedAt': new Date() } },
  );
  return result.modifiedCount > 0;
};
