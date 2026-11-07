import type { i18n as I18next } from 'i18next';

// The active locale's copy for a catalogue entry, keyed by installable id.
// A locale without a map for the entry gets the server's description unchanged,
// so English output and any new entry without a translation stay as they were.
// English has one entry, Linear's, for a row seeded when its server line still
// promised approval, which is not true of a read grant (F321).
export const catalogDescription = (
  i18n: I18next,
  installableId: string,
  serverDescription: string | undefined,
): string | undefined => {
  const key = `connectors.catalogDescriptions.${installableId}`;
  return i18n.exists(key) ? i18n.t(key) : serverDescription;
};
