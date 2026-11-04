import { jest } from '@jest/globals';
import { claudeEffortsFromHelp, codexModelsFromCache, codexRuntimeInventory } from '../src/lib/native-runtime-inventory.js';

test('effort choices come from the installed CLI help, never a global hardcoded menu', () => {
  expect(claudeEffortsFromHelp('  --effort <level> Current effort\n    (low, medium, high)\n  --model <model> Model')).toEqual(['low', 'medium', 'high']);
  expect(claudeEffortsFromHelp('--effort <level> Effort')).toEqual([]);
  expect(claudeEffortsFromHelp('--other <x> (low, medium, high)')).toEqual([]);
});
test('Codex reads only native model cache and offers the intersection of supported levels', () => {
  expect(codexModelsFromCache({ models: [
    { slug: 'a', supported_reasoning_levels: [{ effort: 'high' }, { effort: 'xhigh' }] },
    { slug: 'b', supported_reasoning_levels: [{ effort: 'high' }] },
    { slug: 'hidden', visibility: 'hidden' },
  ] })).toEqual({ models: ['a', 'b'], efforts: ['high'] });
});
// codex-cli 0.162.1 spells visibility 'list' and 'hide'; a 'hide' model
// (gpt-reserve, codex-auto-review) is not one a person should pick (D247).
test('Codex leaves out models the cache marks hide, as well as hidden', () => {
  const level = [{ effort: 'high' }];
  expect(codexModelsFromCache({ models: [
    { slug: 'gpt-6-sol', visibility: 'list', supported_reasoning_levels: level },
    { slug: 'gpt-reserve', visibility: 'hide', supported_reasoning_levels: level },
    { slug: 'codex-auto-review', visibility: 'hide', supported_reasoning_levels: level },
    { slug: 'old-hidden', visibility: 'hidden', supported_reasoning_levels: level },
  ] })).toEqual({ models: ['gpt-6-sol'], efforts: ['high'] });
});
test('cache errors or oversized caches stay unavailable; no provider request or model command runs', async () => {
  const spawnSyncImpl = jest.fn();
  const readFileImpl = jest.fn();
  expect(await codexRuntimeInventory({ spawnSyncImpl, readFileImpl, statImpl: async () => ({ size: 3 * 1024 * 1024 }) }))
    .toEqual({ models: null, efforts: [] });
  expect(spawnSyncImpl).not.toHaveBeenCalled(); expect(readFileImpl).not.toHaveBeenCalled();
});
