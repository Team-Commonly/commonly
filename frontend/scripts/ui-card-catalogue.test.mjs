import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

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

test('sync check refuses drift and write mode restores both copies', () => {
  const root = mkdtempSync(join(tmpdir(), 'card-catalogue-sync-'));
  try {
    for (const dir of ['frontend/scripts','frontend/src/v2/cards','backend/config']) mkdirSync(join(root,dir),{recursive:true});
    const script = join(root,'frontend/scripts/sync-ui-card-catalogue.mjs');
    copyFileSync(new URL('./sync-ui-card-catalogue.mjs',import.meta.url),script);
    for (const file of ['uiCardCatalogue.json','uiCardCatalogueRevision.json']) {
      copyFileSync(new URL(`../../backend/config/${file}`,import.meta.url),join(root,'backend/config',file));
      writeFileSync(join(root,'frontend/src/v2/cards',file),'{}');
    }
    const check = spawnSync(process.execPath,[script,'--check']);
    assert.notEqual(check.status,0); assert.match(check.stderr.toString(),/differs/);
    assert.equal(spawnSync(process.execPath,[script]).status,0);
    for(const file of ['uiCardCatalogue.json','uiCardCatalogueRevision.json']) assert.deepEqual(readFileSync(join(root,'frontend/src/v2/cards',file)),readFileSync(join(root,'backend/config',file)));
    assert.equal(spawnSync(process.execPath,[script,'--check']).status,0);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
