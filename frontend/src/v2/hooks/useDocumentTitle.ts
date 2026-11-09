import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

/*
 * Gives a page its own browser-tab title, localized, in the form
 * "<page> · Commonly". The title the page found is put back when it unmounts,
 * so the landing page and the app shell keep theirs.
 */
export const useDocumentTitle = (pageKey: string): void => {
  const { t } = useTranslation();
  useDocumentTitleText(t(pageKey));
};

/*
 * The same, for a name that isn't a translation key, such as a pod's. A null
 * name leaves the title as it was: a page that has nothing it may show yet,
 * or a pod the viewer can't see, keeps the plain title.
 */
export const useDocumentTitleText = (name: string | null | undefined): void => {
  const { t } = useTranslation();
  const trimmed = name?.trim();
  const title = trimmed ? t('pageTitle.format', { page: trimmed }) : null;
  useEffect(() => {
    if (!title) return undefined;
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
};

export default useDocumentTitle;
