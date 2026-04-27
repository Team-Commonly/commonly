const User = require('../models/User');

const parseBooleanEnv = (value: any): boolean => {
  if (value === undefined || value === null) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};

const normalizeEmail = (email: any): string => String(email || '').trim().toLowerCase();

const sanitizeUsername = (username: any): string => {
  const normalized = String(username || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);

  return normalized || 'localdev';
};

const resolveAvailableUsername = async (requestedUsername: string, existingUserId: any): Promise<string> => {
  const baseUsername = sanitizeUsername(requestedUsername);
  let candidate = baseUsername;
  let attempt = 0;

  while (attempt < 50) {
    const existing = await User.findOne({
      username: candidate,
      ...(existingUserId ? { _id: { $ne: existingUserId } } : {}),
    });

    if (!existing) {
      return candidate;
    }

    attempt += 1;
    candidate = `${baseUsername}-${attempt}`;
  }

  throw new Error('Unable to find an available username for the local dev login.');
};

const ensureLocalDevLogin = async () => {
  if (!parseBooleanEnv(process.env.LOCAL_DEV_LOGIN_ENABLED)) {
    return null;
  }

  const email = normalizeEmail(process.env.LOCAL_DEV_LOGIN_EMAIL);
  const password = String(process.env.LOCAL_DEV_LOGIN_PASSWORD || '');
  const requestedUsername = process.env.LOCAL_DEV_LOGIN_USERNAME || email.split('@')[0] || 'localdev';

  if (!email || !password) {
    console.warn('[local-dev-login] Skipping bootstrap because email or password is missing.');
    return null;
  }

  const existingUser = await User.findOne({ email });
  const username = await resolveAvailableUsername(requestedUsername, existingUser?._id);

  if (existingUser) {
    existingUser.username = username;
    existingUser.password = password;
    existingUser.verified = true;
    await existingUser.save();
    console.log(`[local-dev-login] Ready: ${email} / ${password}`);
    return existingUser;
  }

  const user = new User({
    username,
    email,
    password,
    verified: true,
  });

  await user.save();
  console.log(`[local-dev-login] Ready: ${email} / ${password}`);
  return user;
};

module.exports = {
  ensureLocalDevLogin,
};

export {};
