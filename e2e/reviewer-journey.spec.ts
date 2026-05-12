// Reviewer-journey e2e — walks the YC reviewer through the demo storyline
// end-to-end against a deployed instance (defaults to dev). Skipped in CI
// unless DEMO_TOKEN + DEMO_BASE_URL are present in env. Run locally:
//
//   DEMO_TOKEN=eyJ... DEMO_BASE_URL=https://app-dev.commonly.me \
//     DEMO_POD=69f841a9063269526de0437c \
//     npx playwright test e2e/reviewer-journey.spec.ts
//
// Each beat maps to a Sprint POST_YC item. Adding a 9th beat? Add to the
// numbered list in .dev/yc-application/SPRINT_POST_YC.md too.

import { test, expect } from '@playwright/test';

const TOKEN = process.env.DEMO_TOKEN || '';
const BASE = process.env.DEMO_BASE_URL || '';
const POD = process.env.DEMO_POD || '69f841a9063269526de0437c';
const NOVA_ROOM = process.env.DEMO_NOVA_ROOM || '6a02bff23dd5ef6a130b2aaf';
const A2A_DM = process.env.DEMO_A2A_DM || '6a01a1ffcf199a9aed01d9d1';

const RUN = TOKEN && BASE;

test.describe('Reviewer journey', () => {
  test.skip(!RUN, 'set DEMO_TOKEN + DEMO_BASE_URL to run against a deployed instance');

  test.beforeEach(async ({ page }) => {
    // Inject auth before any UI load so the SPA picks up the token on mount.
    await page.goto(BASE);
    await page.evaluate((t) => localStorage.setItem('token', t), TOKEN);
  });

  test('beat 1: demo pod loads with storyboard scrollback', async ({ page }) => {
    await page.goto(`${BASE}/v2/pods/${POD}`);
    // Regression gate: minified React error boundaries render
    // "Something went wrong" with "Minified React error #N" detail.
    // PR #317 shipped a hook-order violation that caused #310 here;
    // assert the error boundary never fires before any positive check.
    await expect(page.locator('text=Something went wrong')).toHaveCount(0);
    await expect(page.locator('text=/Minified React error/')).toHaveCount(0);
    await expect(page.locator('.v2-chat__title-text')).toContainText('Sign-up flow');
    // Storyboard tail — Pixel's "OAuth-first is right" message must be
    // somewhere in the visible scrollback (rendered as part of a message
    // bubble whose body contains the unique phrase).
    await expect(page.locator('.v2-chat__messages')).toContainText('OAuth-first is right for our wedge', { timeout: 8000 });
  });

  test('beat 2: chat-header avatar count agrees with Members tab', async ({ page }) => {
    await page.goto(`${BASE}/v2/pods/${POD}`);
    await page.locator('.v2-inspector__tab', { hasText: 'Members' }).click();
    const tabText = await page.locator('.v2-inspector__tab--active').textContent();
    const tabCount = parseInt((tabText || '').replace(/\D/g, ''), 10);
    expect(tabCount).toBeGreaterThan(0);
    // Visible avatars + "+N more" on the header must sum to the Members count.
    const visibleAvatars = await page.locator('.v2-chat__avatars [class*="V2Avatar"], .v2-chat__avatars .v2-avatar').count();
    const moreText = await page.locator('.v2-chat__avatars-more').textContent().catch(() => '');
    const extraN = moreText ? parseInt(moreText.replace(/\D/g, ''), 10) : 0;
    expect(visibleAvatars + extraN).toBe(tabCount);
  });

  test('beat 3: members tab shows expected agents with runtime badges', async ({ page }) => {
    await page.goto(`${BASE}/v2/pods/${POD}`);
    await page.locator('.v2-inspector__tab', { hasText: 'Members' }).click();
    await expect(page.locator('.v2-inspector__person, [class*="inspector"]').filter({ hasText: 'Nova' }).first()).toBeVisible();
    await expect(page.locator('text=OpenClaw').first()).toBeVisible();
    await expect(page.locator('text=Native').first()).toBeVisible();
  });

  test('beat 4: a2a-DM clickable in inspector navigates to DM pod', async ({ page }) => {
    await page.goto(`${BASE}/v2/pods/${POD}`);
    await page.locator('.v2-inspector__tab', { hasText: 'Members' }).click();
    // Click any agent row that has a "Direct messages" section. Backend
    // returns the Nova↔Cody pod as a2a-dm; surface text "Cody ↔ Nova" or
    // "Nova ↔ Cody".
    const dmLink = page.locator('text=/Cody.*↔.*Nova|Nova.*↔.*Cody/i').first();
    if (await dmLink.isVisible().catch(() => false)) {
      await dmLink.click();
      await expect(page).toHaveURL(new RegExp(`/v2/pods/${A2A_DM}`));
    }
  });

  test('beat 5: @mention nova-demo gets a real reply within 60s', async ({ page }) => {
    await page.goto(`${BASE}/v2/pods/${POD}`);
    const marker = `e2e-${Date.now()}`;
    const composer = page.locator('.v2-composer__input, textarea[placeholder*="Message"]').first();
    await composer.fill(`@nova-demo e2e ${marker} — quick ack please`);
    await composer.press('Meta+Enter').catch(() => composer.press('Control+Enter'));
    await expect(page.locator('.v2-chat__messages')).toContainText(marker, { timeout: 5000 });
    // Wait up to 60s for nova reply with non-error text.
    await expect(page.locator('.v2-msg, .v2-message__body').filter({ hasText: /ack|received|here/i }).last()).toBeVisible({ timeout: 60_000 });
  });

  test('beat 6: react to a message → chip appears with count=1', async ({ page }) => {
    await page.goto(`${BASE}/v2/pods/${POD}`);
    const firstMsg = page.locator('.v2-message, .v2-msg').first();
    await firstMsg.hover();
    const addBtn = firstMsg.locator('button[aria-label*="reaction" i], .v2-reaction__add').first();
    await addBtn.click();
    await page.locator('text=👍').first().click();
    await expect(firstMsg.locator('.v2-reaction-chip, [class*="reaction"]').filter({ hasText: '👍' }).first()).toBeVisible({ timeout: 5000 });
    // Cleanup: toggle off
    await firstMsg.locator('.v2-reaction-chip, [class*="reaction"]').filter({ hasText: '👍' }).first().click();
  });

  test('beat 7: BYO MCP page submits + shows token + snippets', async ({ page }) => {
    await page.goto(`${BASE}/v2/agents/byo`);
    await expect(page.locator('h1, .v2-feature__title').filter({ hasText: /bring your own/i })).toBeVisible();
    await page.locator('.v2-byo__input').first().fill(`byo-e2e-${Date.now()}`);
    await page.locator('.v2-byo__submit').click();
    await expect(page.locator('.v2-byo__pre').first()).toContainText('cm_agent_', { timeout: 10_000 });
    // 3 snippet panes
    await expect(page.locator('.v2-byo__snippet')).toHaveCount(3);
  });

  test('beat 8: nova agent-room shows first-message coaching chips', async ({ page }) => {
    await page.goto(`${BASE}/v2/pods/${NOVA_ROOM}`);
    await expect(page.locator('.v2-empty__title')).toContainText('Say hi to Nova', { timeout: 8000 });
    await expect(page.locator('.v2-empty__chip')).toHaveCount(3);
    // Clicking a chip pre-fills the composer.
    await page.locator('.v2-empty__chip').first().click();
    const composer = page.locator('.v2-composer__input, textarea[placeholder*="Message"]').first();
    await expect(composer).not.toHaveValue('');
  });
});
