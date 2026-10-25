import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('frontend card grammar is byte-identical to the server grammar', () => {
  const canonical = readFileSync(new URL('../../backend/config/uiCardCatalogue.json', import.meta.url));
  const generated = readFileSync(new URL('../src/v2/cards/uiCardCatalogue.json', import.meta.url));
  assert.deepEqual(generated, canonical, 'Run node frontend/scripts/sync-ui-card-catalogue.mjs');
});

test('frontend revision pin matches the server and ordered grammar hash', async () => {
  const { createHash } = await import('node:crypto');
  const canonical = readFileSync(new URL('../../backend/config/uiCardCatalogueRevision.json', import.meta.url));
  const generated = readFileSync(new URL('../src/v2/cards/uiCardCatalogueRevision.json', import.meta.url));
  assert.deepEqual(generated, canonical);
  const grammar = JSON.parse(readFileSync(new URL('../src/v2/cards/uiCardCatalogue.json', import.meta.url)));
  assert.equal(JSON.parse(generated).catalogHash, `sha256:${createHash('sha256').update(JSON.stringify(grammar)).digest('hex')}`);
});
