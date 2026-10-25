import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('frontend card grammar is byte-identical to the server grammar', () => {
  const canonical = readFileSync(new URL('../../backend/config/uiCardCatalogue.json', import.meta.url));
  const generated = readFileSync(new URL('../src/v2/cards/uiCardCatalogue.json', import.meta.url));
  assert.deepEqual(generated, canonical, 'Run node frontend/scripts/sync-ui-card-catalogue.mjs');
});
