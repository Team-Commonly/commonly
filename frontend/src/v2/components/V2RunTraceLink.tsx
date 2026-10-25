import React from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import './V2RunTrace.css';

/** IDs come from the stored message, never from an agent-authored URL. */
export const runTracePath = (podId: unknown, runId: unknown): string | null => (
  typeof podId === 'string' && /^[a-f\d]{24}$/i.test(podId)
  && typeof runId === 'string' && /^[a-f\d]{24}$/i.test(runId)
    ? `/v2/pods/${podId}/runs/${runId}` : null
);

const V2RunTraceLink: React.FC<{ podId: string; runId?: string }> = ({ podId, runId }) => {
  const { t } = useTranslation();
  const href = runTracePath(podId, runId);
  return href ? <div className="v2-run-trace-link">
    <Link to={href}>{t('runTrace.view')}</Link>
    <span>{t('runTrace.linkRetention')}</span>
  </div> : null;
};
export default V2RunTraceLink;
