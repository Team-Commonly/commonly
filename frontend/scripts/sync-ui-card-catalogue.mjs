import { readFileSync, writeFileSync } from 'node:fs';

// Backend and frontend Docker contexts cannot import across their roots.
// Keep the shipped copy byte-identical, including positional property order.
const canonical = new URL('../../backend/config/uiCardCatalogue.json', import.meta.url);
const generated = new URL('../src/v2/cards/uiCardCatalogue.json', import.meta.url);
const source = readFileSync(canonical);
if (process.argv.includes('--check')) {
  if (!source.equals(readFileSync(generated))) {
    throw new Error('UI card catalogue differs. Run node frontend/scripts/sync-ui-card-catalogue.mjs');
  }
} else {
  writeFileSync(generated, source);
}
