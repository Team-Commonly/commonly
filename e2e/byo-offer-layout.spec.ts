import { test, expect } from '@playwright/test';

// Real layout with a synthetic user and intercepted APIs; no backend write or
// runtime credential is needed. Run against the frontend's normal dev server.
for (const width of [1440, 390]) {
  test(`BYO offer leaves existing commands and controls stationary at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
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
    const initialReservedHeight = await page.locator('.v2-byo__layout').evaluate((el) =>
      parseFloat(getComputedStyle(el).paddingBottom) - 40);
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
    // Put the memory field and action buttons on screen while the timer fires.
    await result.locator('.v2-byo__memory-text').scrollIntoViewIfNeeded();
    await expect(result.locator('.v2-byo__memory-text')).toBeInViewport({ ratio: 1 });
    for (const button of await result.locator('.v2-byo__cta-row button').all()) {
      await expect(button).toBeInViewport({ ratio: 1 });
    }
    const commands = result.locator('.v2-byo__command');
    await expect(commands).toHaveCount(4);
    const before = await commands.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
    const controls = result.locator('.v2-byo__memory-text, .v2-byo__cta-row, .v2-byo__cta-row button');
    await expect(controls).toHaveCount(4);
    const controlsBefore = await controls.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
    await expect(page.locator('.v2-byo__hosted-offer')).toHaveCount(0);
    await page.clock.fastForward(30_001);
    await expect(page.getByRole('status', { name: 'Run it here instead' })).toBeAttached();
    const after = await commands.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
    const controlsAfter = await controls.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
    await testInfo.attach('command-top-positions', {
      body: Buffer.from(JSON.stringify({ width, before, after, controlsBefore, controlsAfter }, null, 2)),
      contentType: 'application/json',
    });
    expect(after).toEqual(before);
    expect(controlsAfter).toEqual(controlsBefore);
    const bar = page.getByRole('status', { name: 'Run it here instead' });
    await expect(bar).toBeInViewport({ ratio: 1 });
    const pane = page.locator('.v2-feature__body');
    await pane.evaluate((el) => { el.scrollTop = 0; });
    await expect(bar).toBeInViewport({ ratio: 1 });
    await pane.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(bar).toBeInViewport({ ratio: 1 });
    const lastControl = result.locator('.v2-byo__cta-row button').last();
    await expect(lastControl).toBeInViewport({ ratio: 1 });
    const controlBox = await lastControl.boundingBox();
    const barBox = await bar.boundingBox();
    expect(controlBox!.y + controlBox!.height).toBeLessThanOrEqual(barBox!.y);
    const reservedHeight = await page.locator('.v2-byo__layout').evaluate((el) =>
      parseFloat(getComputedStyle(el).paddingBottom) - 40);
    expect(reservedHeight).toBe(barBox!.height);
    expect(initialReservedHeight).toBe(barBox!.height);
    const paneBox = await pane.boundingBox();
    expect(Math.abs(barBox!.y + barBox!.height - paneBox!.y - paneBox!.height)).toBeLessThanOrEqual(1);
    expect(await bar.evaluate((el) => getComputedStyle(el).boxShadow)).toBe('none');
    await testInfo.attach('sticky-bar-clearance', {
      body: Buffer.from(JSON.stringify({ width, barHeight: barBox!.height, reservedHeight,
        barTop: barBox!.y, lastControlBottom: controlBox!.y + controlBox!.height }, null, 2)),
      contentType: 'application/json',
    });

    if (width === 390) {
      const provisionError = 'The hosted service could not start this agent. Please try again in a few minutes.';
      await page.route('**/api/registry/agents/next-free-name?*', (route) => route.fulfill({ json: { name: 'alex-hosted-agent' } }));
      await page.route('**/api/hosted/provision', (route) => route.fulfill({ status: 503, json: { error: provisionError } }));
      await bar.getByRole('button', { name: 'Run it here instead', exact: true }).click();
      const error = bar.locator('.v2-byo__error');
      await expect(error).toHaveText(provisionError);
      await expect(error).toBeInViewport({ ratio: 1 });
      const errorGeometry = await error.evaluate((el) => ({
        height: el.getBoundingClientRect().height,
        lineHeight: parseFloat(getComputedStyle(el).lineHeight),
      }));
      expect(errorGeometry.height).toBeGreaterThanOrEqual(errorGeometry.lineHeight * 2);
      expect(await bar.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
      expect(await bar.evaluate((el) => getComputedStyle(el).overflowY)).toBe('visible');
      await testInfo.attach('phone-two-line-provision-error', { body: await page.screenshot({ path: testInfo.outputPath('phone-two-line-provision-error.png') }), contentType: 'image/png' });
      await expect(bar).toBeInViewport({ ratio: 1 });
      await expect(bar.getByRole('button', { name: 'Run it here instead', exact: true })).toBeInViewport({ ratio: 1 });
    }

  });
}
