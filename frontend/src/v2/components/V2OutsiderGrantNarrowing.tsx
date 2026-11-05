// F164 (TASK-781, D244): when an outside-writable connector grant reaches one
// of a seat's pods, runtime auth confines that seat's writes (403
// `outsider_grant_runtime_narrowed`). The server works out where; these two
// notices only say it. Pod names arrive only for pods the viewer can see;
// any other pod is a count.
import React from 'react';
import { useTranslation } from 'react-i18next';

export const NARROWING_CONFIRM_CODE = 'outsider_grant_narrowing_confirm_required';
export const RUNTIME_NARROWED_CODE = 'outsider_grant_runtime_narrowed';

export interface NarrowingPodRef { podId: string; name: string }

/** The install route's 409 `narrowing` body. */
export interface InstallNarrowingPreview {
  code?: string;
  losesWrites: NarrowingPodRef[];
  hiddenLosesWritesCount: number;
  targetWritable: boolean;
}
export type InstallNarrowing = InstallNarrowingPreview | { unavailable: true };

const isPreview = (narrowing: InstallNarrowing): narrowing is InstallNarrowingPreview => !('unavailable' in narrowing);

/** manage-settings `runtimeNarrowing`. */
export interface RuntimeNarrowingStatus {
  code?: string;
  narrowedPodCount: number;
  writablePod: NarrowingPodRef | null;
  writablePodHidden: boolean;
  unavailable?: boolean;
}

/** Reads the install route's refusal. Null for any other error. */
export const installNarrowingFromError = (error: unknown): InstallNarrowing | null => {
  const data = (error as { response?: { status?: number; data?: { code?: string; narrowing?: InstallNarrowing } } })
    ?.response?.data;
  return data?.code === NARROWING_CONFIRM_CODE && data.narrowing ? data.narrowing : null;
};

export const V2InstallNarrowingNotice: React.FC<{
  agentName: string;
  narrowing: InstallNarrowing;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ agentName, narrowing, busy, onConfirm, onCancel }) => {
  const { t } = useTranslation();
  const preview = isPreview(narrowing) ? narrowing : null;
  const losesAny = Boolean(preview && (preview.losesWrites.length > 0 || preview.hiddenLosesWritesCount > 0));
  const lines: string[] = [];
  if (!preview) {
    lines.push(t('outsiderNarrowing.install.unavailable', { name: agentName }));
  } else {
    lines.push(t('outsiderNarrowing.install.lead', { name: agentName }));
    if (losesAny) lines.push(t('outsiderNarrowing.install.losesWrites'));
    if (!preview.targetWritable) lines.push(t('outsiderNarrowing.install.targetBlocked'));
  }
  return (
    <div className="v2-byo__form" data-testid="byo-narrowing-confirmation" role="alert">
      {lines.map((line) => <p key={line} className="v2-byo__error">{line}</p>)}
      {preview && losesAny && (
        <ul data-testid="byo-narrowing-pods">
          {preview.losesWrites.map((pod) => <li key={pod.podId}>{pod.name}</li>)}
          {preview.hiddenLosesWritesCount > 0 && (
            <li>{t('outsiderNarrowing.hiddenPods', { count: preview.hiddenLosesWritesCount })}</li>
          )}
        </ul>
      )}
      <button type="button" className="v2-byo__submit" disabled={busy} onClick={onConfirm}>
        {t('outsiderNarrowing.install.confirm')}
      </button>
      <button type="button" className="v2-byo__link" onClick={onCancel}>
        {t('outsiderNarrowing.install.cancel')}
      </button>
    </div>
  );
};

export const V2RuntimeNarrowingNotice: React.FC<{
  agentName: string;
  status: RuntimeNarrowingStatus;
}> = ({ agentName, status }) => {
  const { t } = useTranslation();
  let text: string;
  if (status.unavailable) {
    text = t('outsiderNarrowing.runtime.unavailable', { name: agentName });
  } else if (status.narrowedPodCount === 1 && status.writablePod) {
    text = t('outsiderNarrowing.runtime.onePod', { name: agentName, pod: status.writablePod.name });
  } else if (status.narrowedPodCount === 1) {
    text = t('outsiderNarrowing.runtime.oneHiddenPod', { name: agentName });
  } else {
    text = t('outsiderNarrowing.runtime.noPod', { name: agentName, count: status.narrowedPodCount });
  }
  return (
    <p className="v2-agent-wake-pods__hint" role="status" data-testid="agent-runtime-narrowing">
      {text}
      {' '}
      <code>{RUNTIME_NARROWED_CODE}</code>
    </p>
  );
};
