import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

/*
 * Gives a page its own browser-tab title, localized, in the form
 * "<page> · Commonly". The title the page found is put back when it unmounts,
 * so the landing page and the app shell keep theirs.
 */
export const useDocumentTitle = (pageKey: string): void => {
  const { t } = useTranslation();
  const title = t('pageTitle.format', { page: t(pageKey) });
  useEffect(() => {
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
};

export default useDocumentTitle;
