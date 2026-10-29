import { readFileSync, writeFileSync } from 'node:fs';

// Each Docker context ships its own byte-identical positional grammar and pin.
for (const file of ['uiCardCatalogue.json', 'uiCardCatalogueRevision.json']) {
  const source = readFileSync(new URL(`../../backend/config/${file}`, import.meta.url));
  const generated = new URL(`../src/v2/cards/${file}`, import.meta.url);
  if (process.argv.includes('--check')) {
    if (!source.equals(readFileSync(generated))) throw new Error(`UI card ${file} differs. Run node frontend/scripts/sync-ui-card-catalogue.mjs`);
  } else writeFileSync(generated, source);
}
