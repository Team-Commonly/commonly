import type { i18n as I18next } from 'i18next';

// The active locale's copy for a catalogue entry, keyed by installable id.
// A locale without a map for the entry gets the server's description unchanged,
// so English output and any new entry without a translation stay as they were.
export const catalogDescription = (
  i18n: I18next,
  installableId: string,
  serverDescription: string | undefined,
): string | undefined => {
  const key = `connectors.catalogDescriptions.${installableId}`;
  return i18n.exists(key) ? i18n.t(key) : serverDescription;
};
