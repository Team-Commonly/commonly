import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { useV2Api } from '../hooks/useV2Api';
import './V2RunTrace.css';

// Ids as the record route accepts them (backend/routes/podRecords.ts).
const POD_ID = /^[a-f\d]{24}$/i;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/** The record page for one board task, or null for ids the route would refuse. */
export const taskRecordPath = (podId: unknown, taskId: unknown): string | null => (
  typeof podId === 'string' && POD_ID.test(podId) && typeof taskId === 'string' && TASK_ID.test(taskId)
    ? `/v2/pods/${podId}/tasks/${encodeURIComponent(taskId)}/record` : null
);

/** One record-v1 line (packages/seats/docs/record-v1.md §1). */
export interface RecordLine {
  seq: number; ts: string; kind: string; runId: string;
  actor: { type: string; id: string; owner?: string } | null;
  data: Record<string, unknown>;
}

// Kinds the server writes today. A reader shows any other kind by its raw name.
const KNOWN_KINDS = new Set([
  'task.claimed', 'task.released', 'task.done', 'grant.issued', 'grant.revoked',
  'permission.requested', 'permission.decided', 'tool.call', 'tool.update',
]);
// Data fields that hold a user id, shown by member name where one is known.
const PERSON_FIELDS = new Set(['doneBy', 'decidedBy', 'issuedBy']);

type LoadError = 'access' | 'members' | 'store' | 'error' | 'unreadable';
const STATUS_ERRORS: Record<number, LoadError> = { 403: 'members', 404: 'access', 503: 'store' };

const isObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);
// The fields this view reads. Parseable text of any other shape (null, a bare
// number, an actor without an id) is as unreadable as text that is not JSON.
const isRecordLine = (value: unknown): value is RecordLine => isObject(value)
  && Number.isInteger(value.seq) && typeof value.ts === 'string'
  && typeof value.kind === 'string' && typeof value.runId === 'string'
  && (value.actor === null || (isObject(value.actor)
    && typeof value.actor.type === 'string' && typeof value.actor.id === 'string'))
  && isObject(value.data);

/** Every line of a record, or a throw when any line is not a record-v1 entry. */
export const parseRecord = (jsonl: string): RecordLine[] => jsonl.split('\n')
  .filter((line) => line.trim())
  .map((line) => {
    const value: unknown = JSON.parse(line);
    if (!isRecordLine(value)) throw new Error('not a record line');
    return value;
  });

const saveFile = (content: string, type: string, name: string) => {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

const V2TaskRecord: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { podId = '', taskId = '' } = useParams<{ podId: string; taskId: string }>();
  const api = useV2Api();
  const valid = taskRecordPath(podId, taskId) !== null;
  const recordUrl = `/api/pods/${encodeURIComponent(podId)}/record/tasks/${encodeURIComponent(taskId)}`;
  const [jsonl, setJsonl] = useState<string | null>(null);
  const [lines, setLines] = useState<RecordLine[]>([]);
  const [error, setError] = useState<LoadError | null>(null);
  const [downloadError, setDownloadError] = useState(false);
  const [names, setNames] = useState<Map<string, string>>(() => new Map());
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    let live = true;
    setJsonl(null); setLines([]); setError(null); setDownloadError(false);
    if (!valid) { setError('access'); return undefined; }
    // Text as served: one JSON object per line, never parsed as a whole.
    api.get<string>(recordUrl, { responseType: 'text', transformResponse: [(body: unknown) => body] })
      .then((body) => {
        if (!live) return;
        const text = typeof body === 'string' ? body : '';
        try { setLines(parseRecord(text)); setJsonl(text); } catch { setError('unreadable'); }
      })
      .catch((err: { response?: { status?: number } }) => {
        if (live) setError(STATUS_ERRORS[err.response?.status || 0] || 'error');
      });
    return () => { live = false; };
  }, [api, recordUrl, valid, attempt]);

  // Actor ids resolve to member names when the pod read allows it; ids stay otherwise.
  useEffect(() => {
    let live = true;
    if (!valid) return undefined;
    api.get<{ members?: Array<{ _id?: string; username?: string; displayName?: string }> }>(`/api/pods/${encodeURIComponent(podId)}`)
      .then((pod) => {
        if (!live) return;
        // A Map, not an object: an id like `__proto__` or `constructor` must
        // never resolve to an inherited property and reach the render.
        setNames(new Map((pod.members || [])
          .filter((member) => member._id)
          .map((member) => [String(member._id), member.displayName || member.username || String(member._id)])));
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [api, podId, valid]);

  const personLabel = useCallback((id: string) => names.get(id) || id, [names]);
  const actorLabel = (actor: RecordLine['actor']) => {
    if (!actor) return t('taskRecord.actor.unknown');
    if (actor.type === 'system') return actor.id === 'board' ? t('taskRecord.actor.board') : t('taskRecord.actor.system', { id: actor.id });
    if (actor.type === 'policy') return t('taskRecord.actor.policy', { id: actor.id });
    if (actor.type === 'agent') return t('taskRecord.actor.agent', { name: personLabel(actor.id) });
    return personLabel(actor.id);
  };
  const kindLabel = (kind: string) => (KNOWN_KINDS.has(kind) ? t(`taskRecord.kinds.${kind.replace('.', '_')}`) : kind);
  const valueLabel = (key: string, value: unknown) => {
    if (typeof value === 'string') return PERSON_FIELDS.has(key) ? personLabel(value) : value;
    return typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value);
  };
  const runId = lines[0]?.runId;
  const fileBase = `${taskId}.record`;

  const downloadOtlp = async () => {
    setDownloadError(false);
    try {
      const otlp = await api.get<unknown>(`${recordUrl}?format=otlp`);
      saveFile(JSON.stringify(otlp), 'application/json', `${fileBase}.otlp.json`);
    } catch { setDownloadError(true); }
  };

  return <section className="v2-run-trace v2-task-record" aria-labelledby="task-record-title">
    <Link className="v2-run-trace__back" to={`/v2/pods/${encodeURIComponent(podId)}/board`}>{t('taskRecord.back')}</Link>
    <h1 id="task-record-title">{t('taskRecord.title')}</h1>
    <p className="v2-run-trace__retention">{t('taskRecord.intro')}</p>
    {jsonl === null && !error && <p role="status">{t('taskRecord.loading')}</p>}
    {error && <div role="alert"><p>{t(`taskRecord.${error}`)}</p>
      {error !== 'access' && error !== 'members' && <button type="button" onClick={retry}>{t('taskRecord.retry')}</button>}
    </div>}
    {jsonl !== null && <>
      <div className="v2-run-trace__summary">
        <strong>{taskId}</strong>
        <span>{t('taskRecord.counts', { count: lines.length })}</span>
        {runId && <code>{t('taskRecord.run', { id: runId })}</code>}
        <div className="v2-task-record__downloads">
          <button type="button" onClick={() => saveFile(jsonl, 'application/x-ndjson', `${fileBase}.jsonl`)}>{t('taskRecord.downloadJsonl')}</button>
          <button type="button" onClick={downloadOtlp}>{t('taskRecord.downloadOtlp')}</button>
        </div>
        {downloadError && <p role="alert">{t('taskRecord.downloadError')}</p>}
      </div>
      {!lines.length && <p>{t('taskRecord.empty')}</p>}
      <ol className="v2-task-record__entries">
        {lines.map((line) => <li className="v2-run-trace__call" key={line.seq}>
          <strong>{kindLabel(line.kind)}</strong>
          <span>{actorLabel(line.actor)} · <time dateTime={line.ts}>{new Date(line.ts).toLocaleString(i18n.resolvedLanguage)}</time></span>
          <code>{t('taskRecord.entry', { number: line.seq })}</code>
          {Object.keys(line.data || {}).length > 0 && <dl>
            {Object.entries(line.data).map(([key, value]) => <React.Fragment key={key}>
              <dt>{key}</dt><dd>{valueLabel(key, value)}</dd>
            </React.Fragment>)}
          </dl>}
        </li>)}
      </ol>
    </>}
  </section>;
};
export default V2TaskRecord;
