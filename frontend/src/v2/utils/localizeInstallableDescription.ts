import i18n from '../../i18n';

export interface LocalizedInstallableDescription {
  description?: string;
  descriptions?: Record<string, string>;
}

/**
 * Installable descriptions follow the language selected in the app, not the
 * browser's Accept-Language header. The API always keeps `description` as the
 * canonical English fallback and projects the locale map for builtins.
 */
export const localizeInstallableDescription = (
  { description, descriptions }: LocalizedInstallableDescription,
  language = i18n.resolvedLanguage ?? i18n.language,
): string => {
  return descriptions?.[language] ?? description ?? '';
};

export default localizeInstallableDescription;
