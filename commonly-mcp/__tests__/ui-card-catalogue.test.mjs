/**
 * commonly_get_ui_card_catalogue serves the package's copy of the server
 * catalogue. These checks fail when that copy drifts from backend/config.
 * The examples are validated by the server's own validator in
 * backend/__tests__/unit/services/uiCardCatalogueSnapshot.test.js.
 */

import { readFileSync } from 'node:fs';
import { jest } from '@jest/globals';
import { buildTools } from '../src/tools.js';

const backendConfig = (file) => JSON.parse(readFileSync(new URL(`../../backend/config/${file}`, import.meta.url), 'utf8'));

const tools = buildTools({ baseUrl: 'https://x.example', token: 'cm_agent_t' });
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

const readCatalogue = async () => {
  const result = await byName.commonly_get_ui_card_catalogue.call();
  return JSON.parse(result.content[0].text);
};

describe('commonly_get_ui_card_catalogue', () => {
  it('returns the revision tuple the backend publishes', async () => {
    const revision = backendConfig('uiCardCatalogueRevision.json');
    const catalogue = await readCatalogue();
    expect(catalogue).toMatchObject({
      catalogId: revision.catalogId,
      catalogRev: revision.catalogRev,
      catalogHash: revision.catalogHash,
    });
  });

  it('returns the component grammar the backend validates against', async () => {
    const catalogue = await readCatalogue();
    expect(catalogue.grammar).toEqual(backendConfig('uiCardCatalogue.json'));
  });

  it('returns the envelope shape and three worked examples', async () => {
    const catalogue = await readCatalogue();
    expect(catalogue.envelope).toMatchObject({ kind: 'ui', v: 1, lang: 'openui@1' });
    expect(catalogue.examples).toHaveLength(3);
    for (const example of catalogue.examples) {
      expect(example.title).toEqual(expect.any(String));
      expect(example.source).toMatch(/^root = /);
    }
  });

  it('needs no network: the call does not reach the API', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    try {
      await byName.commonly_get_ui_card_catalogue.call();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('points the post tool at the catalogue tool and keeps the tuple inline', () => {
    const payloadDescription = byName.commonly_post_message.inputSchema.properties.payload.description;
    expect(payloadDescription).toContain('commonly_get_ui_card_catalogue');
    expect(payloadDescription).toMatch(/sha256:/);
  });
});
