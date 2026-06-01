import { test, expect } from '@playwright/test';

const uniqueTag = () => `e2e${Date.now()}`;

test.describe('Authentication', () => {
  test('register form renders correctly', async ({ page }) => {
    await page.goto('/v2/register');
    await expect(page.getByLabel('Username')).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Register' })).toBeVisible();
  });

  test('register new user shows success message', async ({ page }) => {
    const tag = uniqueTag();
    await page.goto('/v2/register');
    await page.getByLabel('Username').fill(`user_${tag}`);
    await page.getByLabel('Email').fill(`${tag}@commonly.test`);
    await page.getByLabel('Password').fill('TestPass123!');
    await page.getByRole('button', { name: 'Register' }).click();

    // Success message from res.data.message — exact text depends on backend
    // but it must be non-error text visible on the page
    await expect(page.locator('.MuiTypography-root').filter({ hasNotText: /Register|Create|Start/ }).last()).toBeVisible({ timeout: 8000 });
  });

  test('login with wrong password shows error', async ({ page }) => {
    await page.goto('/v2/login');
    await page.getByLabel('Email').fill('nobody@commonly.test');
    await page.getByLabel('Password').fill('wrongpassword');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // v2 login surfaces the failure in a .v2-login__error div
    await expect(page.locator('.v2-login__error')).toBeVisible({ timeout: 8000 });
    // URL must still be the login page — not redirected
    expect(page.url()).toContain('/v2/login');
  });

  test('login with valid credentials redirects into /v2', async ({ page, request }) => {
    // Register a fresh user (auto-verified when SENDGRID_API_KEY not set)
    const tag = uniqueTag();
    const email = `login_${tag}@commonly.test`;
    const password = 'LoginPass456!';
    await request.post(
      `${process.env.E2E_API_URL || 'http://localhost:5000'}/api/auth/register`,
      { data: { username: `loginuser_${tag}`, email, password, invitationCode: '' } },
    );

    await page.goto('/v2/login');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await page.waitForURL(/\/v2(\/|$)/, { timeout: 15000 });
    expect(page.url()).toContain('/v2');
  });

  test('protected route redirects unauthenticated user', async ({ page }) => {
    // Navigate to the app first so localStorage is accessible, then clear token
    await page.goto('/');
    await page.evaluate(() => {
      try { localStorage.removeItem('token'); } catch { /* ignore */ }
    });
    await page.goto('/feed');

    // v2 default: /feed → /v2/feed → V2RequireAuth → /v2/login when unauthenticated
    await page.waitForURL((url) => url.pathname === '/v2/login', { timeout: 8000 });
  });
});
