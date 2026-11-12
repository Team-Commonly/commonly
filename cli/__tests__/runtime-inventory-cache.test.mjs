import { jest } from '@jest/globals';
import { createInventoryCache, INVENTORY_MISSING_MS, INVENTORY_FULL_MS, INVENTORY_SLOW_MS } from '../src/lib/runtime-inventory.js';

const row = (harness, installed) => ({ harness, installed, version: installed ? '1.0' : null, models: null, efforts: [] });

// F370 #8: a harness installed while the page is open shows up without waiting
// five minutes; installed ones aren't probed again until the full refresh.
describe('createInventoryCache', () => {
  test('probes only the missing harnesses again, and only after the short interval', async () => {
    let clock = 0;
    let codexThere = false;
    const collect = jest.fn(async (harnesses) => harnesses.map((h) => row(h, h === 'claude' || (h === 'codex' && codexThere))));
    const inventory = createInventoryCache(collect, { now: () => clock });
    expect((await inventory()).find((r) => r.harness === 'codex').installed).toBe(false);
    expect(collect).toHaveBeenCalledTimes(1);
    clock += INVENTORY_MISSING_MS - 1;
    await inventory();
    expect(collect).toHaveBeenCalledTimes(1);
    codexThere = true;
    clock += 2;
    const next = await inventory();
    const reprobes = collect.mock.calls.length - 1;
    expect(reprobes).toBeGreaterThan(0);
    expect(collect.mock.calls.slice(1).flatMap(([harnesses]) => harnesses)).not.toContain('claude');
    expect(collect.mock.calls.slice(1).flatMap(([harnesses]) => harnesses)).toContain('codex');
    expect(next.find((r) => r.harness === 'codex').installed).toBe(true);
    expect(next.map((r) => r.harness)).toEqual(collect.mock.calls[0][0]);
  });

  test('with everything installed, nothing is probed until the full refresh', async () => {
    let clock = 0;
    const collect = jest.fn(async (harnesses) => harnesses.map((h) => row(h, true)));
    const inventory = createInventoryCache(collect, { now: () => clock });
    await inventory();
    clock += INVENTORY_FULL_MS;
    await inventory();
    expect(collect).toHaveBeenCalledTimes(1);
    clock += 1;
    await inventory();
    expect(collect).toHaveBeenCalledTimes(2);
  });

  // Review of #3980: a harness that's there but hangs on --version blocks the
  // daemon each probe, so after one slow re-probe it waits for the full refresh.
  test('a slow re-probe goes back to the five-minute refresh', async () => {
    let clock = 0;
    const collect = jest.fn(async (harnesses) => {
      if (harnesses.length === 1 && harnesses[0] === 'hermes') clock += INVENTORY_SLOW_MS + 1;
      return harnesses.map((h) => row(h, h !== 'hermes' && h !== 'codex'));
    });
    const inventory = createInventoryCache(collect, { now: () => clock });
    await inventory();
    const probed = () => collect.mock.calls.slice(1).flatMap(([harnesses]) => harnesses);
    clock += INVENTORY_MISSING_MS + 1;
    await inventory();
    expect(probed().filter((h) => h === 'hermes')).toHaveLength(1);
    clock += INVENTORY_MISSING_MS + 1;
    await inventory();
    expect(probed().filter((h) => h === 'hermes')).toHaveLength(1);
    expect(probed().filter((h) => h === 'codex')).toHaveLength(2);
  });
});
