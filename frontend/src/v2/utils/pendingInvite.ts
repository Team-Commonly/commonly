// A registration invitation code reaches the register page in the URL
// fragment (`#invite=CM-…`), or in the query (`?invite=CM-…`) for links made
// before the fragment form. The page reads it once, keeps it for the browser
// session, and takes it out of the address bar, so the code isn't left in
// history or a shared screenshot. A fragment is never sent to a server, so the
// fragment form also keeps the code out of request logs on the way in.

const STORAGE_KEY = 'commonly.pendingInvite';
const OAUTH_MARKER_KEY = 'commonly.pendingInviteOAuth';

export const readInviteFromUrl = (search: string, hash: string): string => {
  const fromHash = new URLSearchParams(hash.replace(/^#/, '')).get('invite');
  const fromQuery = new URLSearchParams(search).get('invite');
  return (fromHash || fromQuery || '').trim();
};

// The search string with `invite` removed and every other parameter kept.
export const searchWithoutInvite = (search: string): string => {
  const params = new URLSearchParams(search);
  params.delete('invite');
  const rest = params.toString();
  return rest ? `?${rest}` : '';
};

// Storage can be unavailable (private windows, blocked site data); the code
// then lives only in the page's state, which is still enough to register.
export const rememberInvite = (code: string): void => {
  if (!code) return;
  try { window.sessionStorage.setItem(STORAGE_KEY, code); } catch { /* storage unavailable */ }
};

export const recallInvite = (): string => {
  try { return window.sessionStorage.getItem(STORAGE_KEY) || ''; } catch { return ''; }
};

export const forgetInvite = (): void => {
  try { window.sessionStorage.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
};

// This marker carries no invitation data. It only tells the OAuth completion
// page that this browser started an invite-bearing signup, so an ordinary
// OAuth login cannot consume an invite left from an earlier visit.
export const rememberInviteOAuthStart = (): void => {
  try { window.sessionStorage.setItem(OAUTH_MARKER_KEY, '1'); } catch { /* storage unavailable */ }
};

export const hasInviteOAuthStart = (): boolean => {
  try { return window.sessionStorage.getItem(OAUTH_MARKER_KEY) === '1'; } catch { return false; }
};

export const forgetInviteOAuthStart = (): void => {
  try { window.sessionStorage.removeItem(OAUTH_MARKER_KEY); } catch { /* storage unavailable */ }
};

export const registerPathWithInvite = (code: string): string => `/v2/register#invite=${encodeURIComponent(code)}`;
