// @ts-nocheck
// F526: a failed sign-in, sign-up, forgot or reset request shows the page's
// own translated line. Server strings (English, for logs) never reach it.
import i18n, { i18nReady } from '../../i18n';
import { authErrorText } from '../utils/authErrorText';

const fail = (status, data) => ({ response: { status, data }, message: `Request failed with status code ${status}` });
const SERVER_TEXT = /rate limit exceeded|Invalid credentials|status code|User already exists|Server error/;

beforeAll(async () => { await i18nReady; });
afterEach(async () => { await i18n.changeLanguage('en'); });

describe('rate limits say what was counted and when to try again', () => {
  test('this network, with the window from the server, rounded up to minutes', () => {
    const line = authErrorText(fail(429, { code: 'rate_limited', scope: 'network', retryAfterSeconds: 610, message: 'rate limit exceeded: 20 login attempts per 15 minutes' }), i18n.t, 'login');
    expect(line).toBe('Too many attempts from this network. Try again in 11 minutes.');
  });
  test('one minute is singular', () => {
    expect(authErrorText(fail(429, { code: 'rate_limited', retryAfterSeconds: 20 }), i18n.t, 'forgot'))
      .toBe('Too many attempts from this network. Try again in 1 minute.');
  });
  test('failed sign-ins for one address point at the reset', () => {
    expect(authErrorText(fail(429, { code: 'rate_limited', scope: 'account', retryAfterSeconds: 300 }), i18n.t, 'login'))
      .toBe('Too many wrong passwords for this email. Try again in 5 minutes, or reset your password.');
  });
  test('no window from the server (an older backend) still says when, plainly', () => {
    expect(authErrorText(fail(429, { message: 'rate limit exceeded' }), i18n.t, 'register'))
      .toBe('Too many attempts from this network. Try again in a few minutes.');
  });
  test('zh-CN', async () => {
    await i18n.changeLanguage('zh-CN');
    expect(authErrorText(fail(429, { code: 'rate_limited', retryAfterSeconds: 610 }), i18n.t, 'login'))
      .toBe('当前网络尝试次数过多，请11分钟后再试。');
    expect(authErrorText(fail(429, { code: 'rate_limited', scope: 'account' }), i18n.t, 'login'))
      .toBe('这个邮箱的密码输错次数太多了，请过几分钟再试，或者重置密码。');
  });
});

describe('no server text reaches the page', () => {
  const cases = [
    ['login', 400, { error: 'Invalid credentials' }, "That email and password don't match."],
    ['login', 403, { error: 'This account has been suspended.', code: 'ACCOUNT_SUSPENDED' }, 'This account has been suspended.'],
    // An edge proxy's challenge page: a 403 with HTML and no code is not a ban.
    ['login', 403, '<!DOCTYPE html><title>Just a moment...</title>', 'Login failed'],
    ['login', 403, { error: 'This instance is limited to the team.', code: 'INSTANCE_ACCESS_RESTRICTED' }, 'This instance is limited to the team. Sign in with your approved email.'],
    ['login', 403, { error: 'This instance is limited to the team.', code: 'INSTANCE_ACCESS_RESTRICTED', reason: 'unverified' }, 'Verify your email first. Open the link we sent you, then sign in.'],
    ['login', 500, 'Server error', 'Something went wrong on our side. Try again in a minute.'],
    ['register', 400, { error: 'User already exists' }, "There's already an account with that email. Sign in instead."],
    ['register', 400, { error: 'Username already exists' }, 'Registration failed.'],
    ['register', 409, { error: 'That email address is reserved for agents.', code: 'agent_email_reserved' }, "That email can't be used for a new account."],
    ['register', 503, { error: 'Email verification is unavailable…', code: 'INSTANCE_VERIFICATION_UNAVAILABLE' }, "Email sign-up isn't available right now. Continue with GitHub or Google."],
    ['register', 503, { error: 'Registration is currently invite-only…', code: 'INVITATION_CONFIG_MISSING' }, 'Sign-ups are paused right now. Try again later.'],
    ['register', 403, { error: 'Invalid invitation code.', code: 'INVITATION_INVALID' }, "That invitation code didn't work. Check it and try again."],
    ['forgot', 400, { message: 'something odd' }, 'Something went wrong — try again.'],
    ['reset', 400, { error: 'Invalid or expired token' }, 'Reset failed — the link may have expired.'],
  ];
  test.each(cases)('%s %i → its own line', (page, status, data, expected) => {
    const line = authErrorText(fail(status, data), i18n.t, page);
    expect(line).toBe(expected);
    expect(line).not.toMatch(SERVER_TEXT);
  });
  test('a network failure (no response) says so', () => {
    expect(authErrorText(new Error('Network Error'), i18n.t, 'login'))
      .toBe("Can't reach Commonly right now. Check your connection and try again.");
  });
  test('zh-CN lines are Chinese, not the English server text', async () => {
    await i18n.changeLanguage('zh-CN');
    expect(authErrorText(fail(400, { error: 'Invalid credentials' }), i18n.t, 'login')).toBe('邮箱或密码不正确。');
    expect(authErrorText(fail(400, { error: 'User already exists' }), i18n.t, 'register')).toBe('这个邮箱已经注册过了，直接登录就行。');
  });
});
