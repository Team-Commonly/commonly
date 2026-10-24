// Instance-local human sign-in gate. Unset lists leave public instances alone.
const entries = (value: string | undefined) => (value || '')
  .split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);

export const isInstanceAccessRestricted = () => entries(process.env.AUTH_ALLOWED_EMAILS).length > 0
  || entries(process.env.AUTH_ALLOWED_DOMAINS).length > 0;

export const isInstanceEmailAllowed = (rawEmail: unknown) => {
  if (!isInstanceAccessRestricted()) return true;
  if (typeof rawEmail !== 'string') return false;
  const email = rawEmail.trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1 || email.indexOf('@') !== at) return false;
  if (entries(process.env.AUTH_ALLOWED_EMAILS).includes(email)) return true;
  const domain = email.slice(at + 1);
  return entries(process.env.AUTH_ALLOWED_DOMAINS)
    .some((allowed) => allowed.replace(/^@/, '') === domain);
};

export const INSTANCE_ACCESS_ERROR = 'This instance is limited to the team.';
