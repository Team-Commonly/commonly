import { test as base, Page, APIRequestContext } from '@playwright/test';

const E2E_API_URL = process.env.E2E_API_URL || 'http://localhost:5000';

export const TEST_USER = {
  username: 'e2etestuser',
  email: 'e2etest@commonly.test',
  password: 'E2eTestPass123!',
};

/**
 * Registers and verifies a test user via the API.
 * When SENDGRID_API_KEY is not set the backend auto-verifies on register,
 * so no email step is needed.
 */
export async function ensureTestUser(request: APIRequestContext): Promise<void> {
  // Attempt registration — ignore 400/409 if user already exists
  await request.post(`${E2E_API_URL}/api/auth/register`, {
    data: {
      username: TEST_USER.username,
      email: TEST_USER.email,
      password: TEST_USER.password,
      invitationCode: '',
    },
  });
}

type AuthFixtures = {
  authenticatedPage: Page;
};

export const test = base.extend<AuthFixtures>({
  authenticatedPage: async ({ page, request }, use) => {
    await ensureTestUser(request);

    await page.goto('/login');
    await page.getByLabel('Email').fill(TEST_USER.email);
    await page.getByLabel('Password').fill(TEST_USER.password);
    await page.getByRole('button', { name: 'Login' }).click();
    await page.waitForURL('**/feed', { timeout: 15000 });

    await use(page);
  },
});

export { expect } from '@playwright/test';
