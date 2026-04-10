import { test, expect } from '././fixtures/auth';

test.describe('Pods', () => {
  test('authenticated user can view pod listing', async ({ authenticatedPage: page }) => {
    await page.goto('/pods');
    // Page should render pod UI — at minimum no crash/blank page
    await expect(page.locator('#root')).toBeAttached();
    // URL should remain on /pods (not redirected to /login)
    expect(page.url()).toContain('/pods');
  });

  test('authenticated user can navigate to feed', async ({ authenticatedPage: page }) => {
    await page.goto('/feed');
    await expect(page.locator('#root')).toBeAttached();
    expect(page.url()).toContain('/feed');
  });

  test('api/pods returns array for authenticated user', async ({ authenticatedPage: page, request }) => {
    // Extract token from localStorage set during login
    const token = await page.evaluate(() => localStorage.getItem('token'));
    expect(token).toBeTruthy();

    const res = await request.get(
      `${process.env.E2E_API_URL || 'http://localhost:5000'}/api/pods`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});
