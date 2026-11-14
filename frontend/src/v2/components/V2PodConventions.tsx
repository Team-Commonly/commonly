import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useV2Api } from '../hooks/useV2Api';
import { formatRelativeTime } from '../utils/grouping';

// F498: the pod's conventions (F124, docs/agents/pod-conventions.md). Every
// agent turn in the pod reads them, so members see them here, and the pod's
// creator (canEdit, decided by the server) writes them against the API's
// revision check.

const MAX_CODE_POINTS = 4000;

interface ConventionsRead {
  podId: string;
  revision: number;
  conventions: { text: string; updatedAt?: string; updatedBy?: { userId?: string; label?: string } } | null;
  permissions?: { canEdit?: boolean };
}

const codePoints = (value: string): number => Array.from(value).length;

const V2PodConventions: React.FC<{ podId: string }> = ({ podId }) => {
  const { t } = useTranslation();
  const api = useV2Api();
  const fieldId = useId();
  const [read, setRead] = useState<ConventionsRead | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'absent'>('loading');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [baseRevision, setBaseRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<ConventionsRead | null>(null);
  const requestRef = useRef(0);
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const actionRef = useRef<HTMLButtonElement | null>(null);
  // Where focus goes after the editor opens or closes; null leaves it alone.
  const focusNextRef = useRef<'field' | 'action' | null>(null);

  useEffect(() => {
    const requestId = ++requestRef.current;
    setState('loading');
    setEditing(false);
    setLatest(null);
    setSaveError(null);
    api.get<ConventionsRead>(`/api/pods/${encodeURIComponent(podId)}/conventions`)
      .then((data) => {
        if (requestId !== requestRef.current) return;
        setRead(data);
        setCanEdit(Boolean(data?.permissions?.canEdit));
        setState('ready');
      })
      .catch((error: { response?: { status?: number } }) => {
        if (requestId !== requestRef.current) return;
        // A server from before F124, or a pod this reader can't see: no section body.
        setState(error?.response?.status === 404 || error?.response?.status === 403 ? 'absent' : 'error');
      });
  }, [api, podId]);

  useEffect(() => {
    const target = focusNextRef.current;
    if (!target) return;
    focusNextRef.current = null;
    (target === 'field' ? fieldRef.current : actionRef.current)?.focus();
  }, [editing]);

  const closeEditor = () => {
    focusNextRef.current = 'action';
    setEditing(false);
    setLatest(null);
    setSaveError(null);
  };

  const startEditing = () => {
    focusNextRef.current = 'field';
    setDraft(read?.conventions?.text || '');
    setBaseRevision(read?.revision ?? 0);
    setLatest(null);
    setSaveError(null);
    setEditing(true);
  };

  const save = useCallback(async () => {
    if (saving) return;
    const trimmed = draft.trim();
    // The pod can change while the save is in flight; the read effect bumps
    // requestRef then, and a stale answer must not land in the new pod's view.
    const requestId = requestRef.current;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await api.patch<ConventionsRead>(`/api/pods/${encodeURIComponent(podId)}/conventions`, {
        expectedRevision: baseRevision,
        text: trimmed ? trimmed : null,
      });
      if (requestId !== requestRef.current) return;
      setRead(result);
      closeEditor();
    } catch (error) {
      if (requestId !== requestRef.current) return;
      const e = error as { response?: { status?: number; data?: { current?: ConventionsRead } } };
      if (e?.response?.status === 409) {
        // Keep the draft; show what is saved now, and let the next Save replace it.
        let current = e.response.data?.current;
        if (!current) {
          try {
            current = await api.get<ConventionsRead>(`/api/pods/${encodeURIComponent(podId)}/conventions`);
          } catch {
            current = undefined;
          }
          if (requestId !== requestRef.current) return;
        }
        if (!current) {
          setConflict(false);
          setSaveError(t('inspector.conventions.saveError'));
          return;
        }
        setLatest(current);
        setRead((prev) => ({ ...current, permissions: prev?.permissions }));
        setBaseRevision(current.revision);
        setConflict(true);
        setSaveError(t('inspector.conventions.conflict', {
          name: current.conventions?.updatedBy?.label || t('inspector.conventions.someone'),
        }));
      } else {
        setConflict(false);
        setSaveError(t('inspector.conventions.saveError'));
      }
    } finally {
      // A save from the pod before a switch must not re-enable the next pod's Save.
      if (requestId === requestRef.current) setSaving(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- closeEditor only sets state and refs
  }, [api, baseRevision, draft, podId, saving, t]);

  if (state === 'absent') return null;
  if (state === 'loading') return <p className="v2-pod-conventions__muted">{t('inspector.conventions.loading')}</p>;
  if (state === 'error') return <p className="v2-pod-conventions__muted" role="status">{t('inspector.conventions.loadError')}</p>;

  const saved = read?.conventions || null;
  const used = codePoints(draft.trim());
  const left = MAX_CODE_POINTS - used;

  return (
    <div className="v2-pod-conventions" data-testid="pod-conventions">
      {!editing && (
        <>
          {saved ? (
            <>
              <p className="v2-pod-conventions__text" data-testid="pod-conventions-text">{saved.text}</p>
              <p className="v2-pod-conventions__meta">
                {t('inspector.conventions.setBy', {
                  name: saved.updatedBy?.label || t('inspector.conventions.someone'),
                  when: formatRelativeTime(saved.updatedAt),
                })}
              </p>
            </>
          ) : (
            <p className="v2-pod-conventions__muted">
              {t(canEdit ? 'inspector.conventions.emptyOwner' : 'inspector.conventions.empty')}
            </p>
          )}
          {canEdit && (
            <button ref={actionRef} type="button" className="v2-pod-conventions__action" onClick={startEditing}>
              {t(saved ? 'inspector.conventions.edit' : 'inspector.conventions.write')}
            </button>
          )}
        </>
      )}
      {editing && (
        <div className="v2-pod-conventions__editor">
          <textarea
            ref={fieldRef}
            id={fieldId}
            aria-label={t('inspector.conventions.label')}
            aria-describedby={`${fieldId}-count`}
            className="v2-pod-conventions__field"
            value={draft}
            rows={6}
            readOnly={saving}
            placeholder={t('inspector.conventions.placeholder')}
            onChange={(event) => setDraft(event.target.value)}
          />
          <p id={`${fieldId}-count`} className={`v2-pod-conventions__count${left < 0 ? ' v2-pod-conventions__count--over' : ''}`}>
            {left < 0
              ? t('inspector.conventions.over', { count: -left })
              : t('inspector.conventions.left', { count: left })}
          </p>
          {saveError && <p className={`v2-pod-conventions__error${conflict ? ' v2-pod-conventions__error--conflict' : ''}`} role="alert">{saveError}</p>}
          {latest && (
            <blockquote className="v2-pod-conventions__latest" data-testid="pod-conventions-latest">
              {latest.conventions?.text || t('inspector.conventions.latestCleared')}
            </blockquote>
          )}
          <div className="v2-pod-conventions__buttons">
            <button type="button" className="v2-pod-conventions__save" disabled={saving || left < 0} onClick={() => { void save(); }}>
              {t('inspector.conventions.save')}
            </button>
            <button type="button" className="v2-pod-conventions__cancel" disabled={saving} onClick={closeEditor}>
              {t('inspector.conventions.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default V2PodConventions;
