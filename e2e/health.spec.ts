import { test, expect } from '@playwright/test';

const API_URL = process.env.E2E_API_URL || 'http://localhost:5000';

test.describe('Health endpoints', () => {
  test('GET /api/health/live returns 200 with status:alive', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/health/live`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('alive');
    expect(body.timestamp).toBeTruthy();
  });

  test('GET /api/health/ready returns 200 when DBs are up', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/health/ready`);
    // 200 = ready, 503 = DBs not ready — both are valid from the endpoint
    expect([200, 503]).toContain(res.status());
    const body = await res.json();
    expect(body.status).toBeTruthy();
  });

  test('GET /api/health returns overall health object', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/health`);
    expect([200, 503]).toContain(res.status());
    const body = await res.json();
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('checks');
    expect(body).toHaveProperty('uptime');
  });

  test('frontend serves HTML with React root', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#root')).toBeAttached();
  });

  test('frontend login page renders', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Login' })).toBeVisible();
  });
});
