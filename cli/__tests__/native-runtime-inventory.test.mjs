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
test('cache errors or oversized caches stay unavailable; no provider request or model command runs', async () => {
  const spawnSyncImpl = jest.fn();
  const readFileImpl = jest.fn();
  expect(await codexRuntimeInventory({ spawnSyncImpl, readFileImpl, statImpl: async () => ({ size: 3 * 1024 * 1024 }) }))
    .toEqual({ models: null, efforts: [] });
  expect(spawnSyncImpl).not.toHaveBeenCalled(); expect(readFileImpl).not.toHaveBeenCalled();
});
