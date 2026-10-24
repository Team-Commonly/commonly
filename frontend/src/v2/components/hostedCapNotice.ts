import type { TFunction } from 'i18next';

// The beta cap refusal (403 hosted_cap_reached) names the seat that holds the
// slot, so the person can open it instead of being told only that they are
// capped. The holders come from the server; nothing here guesses a name.
export interface HostedCapBody {
  cap?: number;
  holders?: Array<{ agentName?: string }>;
}

export const hostedCapNotice = (t: TFunction, body: HostedCapBody | undefined, fallbackCap = 1): string => {
  const cap = body?.cap ?? fallbackCap;
  const holder = body?.holders?.find((row) => row.agentName)?.agentName;
  return holder
    ? t('agentByo.errors.hostedCapHeld', { holder, cap })
    : t('agentByo.errors.hostedCap', { cap });
};
