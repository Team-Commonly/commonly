import { test, expect } from '@playwright/test';

// Real layout with a synthetic user and intercepted APIs; no backend write or
// runtime credential is needed. Run against the frontend's normal dev server.
for (const width of [1440, 390]) {
  test(`BYO offer leaves every command top unchanged at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.clock.install();
    await page.addInitScript(() => {
      localStorage.setItem('token', 'fixture-only-user');
      localStorage.setItem('v2.lang', 'en');
    });
    await page.route('**/api/**', async (route) => {
      const { pathname, searchParams } = new URL(route.request().url());
      let data: unknown = {};
      if (pathname === '/api/auth/user') data = { _id: 'fixture-owner', username: 'alex', email: 'fixture@example.invalid', verified: true };
      else if (pathname === '/api/pods') data = [{ _id: 'fixture-pod', name: 'Workspace', type: 'chat', createdBy: { _id: 'fixture-owner' } }];
      else if (pathname === '/api/hosted/availability') data = { configured: true, caps: { agentsPerUser: 1, turnsPerDay: 200 } };
      else if (pathname === '/api/machines') data = { machines: [] };
      else if (pathname.endsWith('next-free-name')) data = { name: searchParams.get('base') };
      else if (pathname.includes('runtime-tokens')) data = { token: 'fixture-only-key' };
      else if (pathname.includes('attention')) data = { items: [], count: 0 };
      await route.fulfill({ json: data });
    });
    await page.goto('/v2/agents/byo');
    await page.getByTestId('byo-mode-byo').click();
    await page.getByRole('button', { name: 'Get my connect command', exact: true }).click();
    const result = page.locator('.v2-byo__result');
    await expect(result).toBeVisible();
    // Fix the setup OS, independently of the runner's emulated user agent.
    await page.getByRole('button', { name: 'Mac', exact: true }).click();
    // Include commands inside Other ways: checking only the first command
    // missed the original regression, where later copy targets moved.
    await result.locator('details').evaluateAll((details) => details.forEach((el) => { (el as HTMLDetailsElement).open = true; }));
    await page.evaluate(() => document.fonts.ready);
    const commands = result.locator('.v2-byo__command');
    await expect(commands).toHaveCount(4);
    const before = await commands.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
    await expect(result.locator('.v2-byo__hosted-offer')).toHaveCount(0);
    await page.clock.fastForward(30_001);
    await expect(result.getByRole('status', { name: 'Run it here instead' })).toBeAttached();
    const after = await commands.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
    await testInfo.attach('command-top-positions', {
      body: Buffer.from(JSON.stringify({ width, before, after }, null, 2)),
      contentType: 'application/json',
    });
    expect(after).toEqual(before);
    expect(await result.evaluate((el) => {
      const offer = el.querySelector('.v2-byo__hosted-offer')!;
      return [...el.querySelectorAll('.v2-byo__command')].every((command) =>
        Boolean(command.compareDocumentPosition(offer) & Node.DOCUMENT_POSITION_FOLLOWING));
    })).toBe(true);
  });
}
