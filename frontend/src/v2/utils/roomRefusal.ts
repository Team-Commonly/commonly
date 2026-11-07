import type { TFunction } from 'i18next';

// A refused 1:1 can have a reason the person can act on. It's read from the
// code, not the server's message, so it reads in the app's language.
export const roomRefusal = (error: unknown, t: TFunction): string | null => {
  const code = (error as { response?: { data?: { code?: string } } })?.response?.data?.code;
  return code === 'hosted_no_shared_owner' ? t('agentProfile.hero.noSharedHost') : null;
};
