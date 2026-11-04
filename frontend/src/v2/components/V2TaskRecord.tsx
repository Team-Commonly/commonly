import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { useV2Api } from '../hooks/useV2Api';
import { appDateLocale } from '../utils/appLocale';
import { KindGlyph, RecordGlyph, RecordGlyphName, ShellGlyph } from '../icons/glyphs';
import V2Avatar from './V2Avatar';
import V2Hint from './V2Hint';
import './V2TaskRecord.css';

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

// A pod member as the record shows them: a name, and an avatar when the pod read has one.
interface Member { name: string; src?: string; isBot?: boolean }

// One mark per kind (d215 s-task-record). Done is the only filled one.
const KIND_MARKS: Record<string, RecordGlyphName | 'approval' | 'check'> = {
  'task.claimed': 'play', 'task.released': 'block', 'task.done': 'check',
  'grant.issued': 'key', 'grant.revoked': 'key',
  'permission.requested': 'approval', 'permission.decided': 'check',
  'tool.call': 'term', 'tool.update': 'term',
};
const KindMark: React.FC<{ kind: string }> = ({ kind }) => {
  const mark = KIND_MARKS[kind] || 'dot';
  if (mark === 'approval') return <KindGlyph kind="approval" size={14} />;
  if (mark === 'check') return <ShellGlyph name="check" size={14} />;
  return <RecordGlyph name={mark} size={14} />;
};

// Values the writers put in a release's `reason` and a decision's `kind` /
// `outcome` (taskRecordService, kernelWorkSweepService, brokerRecordLines,
// record-v1 §2). Any other value shows as written, underscores as spaces.
const RELEASE_REASONS = new Set(['blocked', 'lease_expired', 'reassigned', 'abandoned']);
const DECISIONS = new Set(['allow_once', 'reject_once', 'allow_always', 'reject_always', 'selected', 'cancelled']);
const spaced = (value: string) => value.replace(/_/g, ' ');

// A digest as the frame draws it: the algorithm, the first and last four hex
// characters. The full value stays in the cell's title.
const DIGEST = /^(sha256:)([0-9a-f]{4})[0-9a-f]{4,}([0-9a-f]{4})$/i;
export const shortDigest = (value: string): string => {
  const match = DIGEST.exec(value);
  return match ? `${match[1]}${match[2]}…${match[3]}` : value;
};

// The server's MAX_PAGE_LINES. A page this long may have more after it.
const RECORD_PAGE_LINES = 1000;

type LoadError = 'access' | 'members' | 'store' | 'error' | 'unreadable';
// A page the reader cannot follow: its cursor is missing, or does not move on.
class UnreadablePage extends Error {}
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
  const [names, setNames] = useState<Map<string, Member>>(() => new Map());
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    let live = true;
    setJsonl(null); setLines([]); setError(null); setDownloadError(false);
    if (!valid) { setError('access'); return undefined; }
    // Text as served: one JSON object per line, never parsed as a whole. The
    // server pages the chain, and a full page means more may follow, so keep
    // reading from the last seq until a page comes back short.
    const readText = async (): Promise<string> => {
      const options = { responseType: 'text' as const, transformResponse: [(body: unknown) => body] };
      let text = '';
      for (let after = 0; ;) {
        const page = await api.get<string>(`${recordUrl}?after=${after}&limit=${RECORD_PAGE_LINES}`, options);
        const body = typeof page === 'string' ? page : '';
        if (!body) break;
        text += body;
        const lines = body.trimEnd().split('\n');
        if (lines.length < RECORD_PAGE_LINES) break;
        // The cursor is the last line's seq, and it must move forward.
        let next: unknown;
        try { next = (JSON.parse(lines[lines.length - 1]) as { seq?: unknown }).seq; } catch { throw new UnreadablePage(); }
        if (!Number.isInteger(next) || (next as number) <= after) throw new UnreadablePage();
        after = next as number;
      }
      return text;
    };
    readText()
      .then((text) => {
        if (!live) return;
        try { setLines(parseRecord(text)); setJsonl(text); } catch { setError('unreadable'); }
      })
      .catch((err: { response?: { status?: number } } & Error) => {
        if (!live) return;
        if (err instanceof UnreadablePage || err instanceof SyntaxError) setError('unreadable');
        else setError(STATUS_ERRORS[err.response?.status || 0] || 'error');
      });
    return () => { live = false; };
  }, [api, recordUrl, valid, attempt]);

  // Actor ids resolve to member names when the pod read allows it; ids stay otherwise.
  useEffect(() => {
    let live = true;
    if (!valid) return undefined;
    api.get<{ members?: Array<{ _id?: string; username?: string; displayName?: string; profilePicture?: string; isBot?: boolean }> }>(`/api/pods/${encodeURIComponent(podId)}`)
      .then((pod) => {
        if (!live) return;
        // A Map, not an object: an id like `__proto__` or `constructor` must
        // never resolve to an inherited property and reach the render.
        setNames(new Map((pod.members || [])
          .filter((member) => member._id)
          .map((member) => [String(member._id), {
            name: member.displayName || member.username || String(member._id),
            src: typeof member.profilePicture === 'string' ? member.profilePicture : undefined,
            isBot: typeof member.isBot === 'boolean' ? member.isBot : undefined,
          }])));
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [api, podId, valid]);

  // The task's title, from the board's own list (there is no single-task read).
  // Never blocks the record: until it lands, or if it fails or the task is not
  // in the list, the heading stays the id.
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setTitle(null);
    if (!valid) return undefined;
    api.get<{ tasks?: Array<{ taskId?: unknown; title?: unknown }> }>(`/api/v1/tasks/${encodeURIComponent(podId)}`)
      .then((data) => {
        if (!live || !Array.isArray(data?.tasks)) return;
        const task = data.tasks.find((row) => row && row.taskId === taskId);
        if (task && typeof task.title === 'string' && task.title.trim()) setTitle(task.title);
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [api, podId, taskId, valid]);

  const personLabel = useCallback((id: string) => names.get(id)?.name || id, [names]);
  const actorLabel = (actor: RecordLine['actor']) => {
    if (!actor) return t('taskRecord.actor.unknown');
    if (actor.type === 'system') return actor.id === 'board' ? t('taskRecord.actor.board') : t('taskRecord.actor.system', { id: actor.id });
    if (actor.type === 'policy') return t('taskRecord.actor.policy', { id: actor.id });
    return personLabel(actor.id);
  };
  // People and agents carry their avatar; Board, System, Policy and an unknown actor a tile.
  const actorMark = (actor: RecordLine['actor']) => {
    if (actor && (actor.type === 'agent' || actor.type === 'human')) {
      const member = names.get(actor.id);
      const kind = member?.isBot !== undefined ? (member.isBot ? 'agent' : 'human') : actor.type;
      return <V2Avatar name={personLabel(actor.id)} src={member?.src} kind={kind} seed={actor.id} size="sm" className="v2-task-record__av" />;
    }
    return <span className="v2-task-record__sys" aria-hidden="true">
      {actor?.type === 'system' && actor.id === 'board' ? <ShellGlyph name="board" size={12} />
        : actor?.type === 'policy' ? <KindGlyph kind="approval" size={12} />
          : <ShellGlyph name="gear" size={12} />}
    </span>;
  };
  const kindLabel = (kind: string) => (KNOWN_KINDS.has(kind) ? t(`taskRecord.kinds.${kind.replace('.', '_')}`) : kind);
  const valueLabel = (key: string, value: unknown) => {
    if (typeof value === 'string') return PERSON_FIELDS.has(key) ? personLabel(value) : value;
    return typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value);
  };
  const locale = appDateLocale(i18n.resolvedLanguage);
  const clock = (ts: unknown) => {
    const date = typeof ts === 'string' ? new Date(ts) : null;
    return date && !Number.isNaN(date.getTime()) ? date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : null;
  };
  const dayOf = (ts: string) => {
    const date = new Date(ts);
    return Number.isNaN(date.getTime()) ? ts : date.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' });
  };
  // One mono line of the entry's own data, per kind; any other kind shows its first plain values.
  const str = (value: unknown) => (typeof value === 'string' && value ? value : null);
  const summary = (line: RecordLine): string => {
    const d = line.data || {};
    const parts: Array<string | null> = [];
    switch (line.kind) {
      case 'task.claimed': { const time = clock(d.leaseUntil); parts.push(time ? t('taskRecord.line.leaseUntil', { time }) : null); break; }
      case 'task.released': {
        const reason = str(d.reason);
        parts.push(reason && t('taskRecord.line.reason', {
          reason: RELEASE_REASONS.has(reason) ? t(`taskRecord.reasons.${reason}`) : spaced(reason),
        }));
        break;
      }
      case 'task.done': parts.push(str(d.doneBy) && t('taskRecord.line.doneBy', { name: personLabel(d.doneBy as string) })); break;
      case 'permission.requested': {
        const asked = isObject(d.askedOf) ? str(d.askedOf.id) : null;
        parts.push(str(d.question), asked && t('taskRecord.line.askedOf', { name: personLabel(asked) }));
        break;
      }
      case 'permission.decided': {
        const decision = str(d.kind) || str(d.outcome);
        parts.push(decision && (DECISIONS.has(decision) ? t(`taskRecord.decisions.${decision}`) : spaced(decision)));
        break;
      }
      case 'tool.call': case 'tool.update': parts.push(str(d.name) || str(d.title), str(d.status)); break;
      case 'grant.issued': parts.push(str(d.grantId)); break;
      case 'grant.revoked': parts.push(str(d.reason)); break;
      default:
        // Plain values first, then two: an object field between them must not
        // push a plain one out (attempt.settled: {attempt, failure: {…}, outcome}).
        Object.entries(d)
          .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
          .slice(0, 2)
          .forEach(([key, value]) => parts.push(valueLabel(key, value)));
    }
    return parts.filter(Boolean).join(' · ');
  };
  const runId = lines[0]?.runId;
  const fileBase = `${taskId}.record`;
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const toggle = (seq: number) => setOpen((now) => {
    const next = new Set(now);
    if (next.has(seq)) next.delete(seq); else next.add(seq);
    return next;
  });
  const [menuOpen, setMenuOpen] = useState(false);
  // Another task's page starts closed: row seqs repeat across tasks, so an
  // open row or the Download menu must not carry over.
  useEffect(() => { setOpen(new Set()); setMenuOpen(false); }, [podId, taskId]);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!menuOpen) return undefined;
    const away = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [menuOpen]);

  const downloadOtlp = async () => {
    setDownloadError(false);
    try {
      const otlp = await api.get<unknown>(`${recordUrl}?format=otlp`);
      saveFile(JSON.stringify(otlp), 'application/json', `${fileBase}.otlp.json`);
    } catch { setDownloadError(true); }
  };
  const choose = (save: () => void) => { setMenuOpen(false); save(); };

  // Entries grouped by the day they happened on, in record order.
  const days: Array<{ day: string; entries: RecordLine[] }> = [];
  lines.forEach((line) => {
    const day = dayOf(line.ts);
    if (days[days.length - 1]?.day === day) days[days.length - 1].entries.push(line);
    else days.push({ day, entries: [line] });
  });
  const loaded = jsonl !== null;
  const counts = t('taskRecord.counts', { count: lines.length });
  const retryable = error !== null && error !== 'access' && error !== 'members';

  return <div className="v2-task-record">
    <header className="v2-task-record__head">
      <Link className="v2-task-record__key v2-task-record__key--ghost v2-task-record__key--icon" to={`/v2/pods/${encodeURIComponent(podId)}/board`}
        aria-label={t('taskRecord.back')} title={t('taskRecord.back')}>
        <RecordGlyph name="back" size={17} />
      </Link>
      <h1 id="task-record-title" className="v2-task-record__title">{t('taskRecord.title')}</h1>
      <V2Hint label={t('taskRecord.about')}>{t('taskRecord.intro')}</V2Hint>
      <span className="v2-task-record__meta">{loaded ? `${taskId} · ${counts}` : taskId}</span>
      <span className="v2-task-record__sp" />
      {loaded && <div className="v2-task-record__download" ref={menuRef}
        onKeyDown={(event) => { if (event.key === 'Escape') setMenuOpen(false); }}>
        <button type="button" className="v2-task-record__key v2-task-record__key--soft v2-task-record__key--sm v2-task-record__download-key"
          aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuOpen ? menuId : undefined}
          aria-label={t('taskRecord.download')} title={t('taskRecord.download')} onClick={() => setMenuOpen((value) => !value)}>
          <RecordGlyph name="download" size={16} />
          <span className="v2-task-record__download-word">{t('taskRecord.download')}</span>
          <span className="v2-task-record__download-chev"><ShellGlyph name="chevron" size={16} /></span>
        </button>
        {menuOpen && <div className="v2-task-record__menu" role="menu" id={menuId}>
          <button type="button" role="menuitem" aria-label={t('taskRecord.downloadJsonl')}
            onClick={() => choose(() => saveFile(jsonl as string, 'application/x-ndjson', `${fileBase}.jsonl`))}>
            <ShellGlyph name="file" size={15} />JSONL<span className="v2-task-record__ext">.jsonl</span>
          </button>
          <button type="button" role="menuitem" aria-label={t('taskRecord.downloadOtlp')} onClick={() => choose(downloadOtlp)}>
            <RecordGlyph name="activity" size={15} />OTLP<span className="v2-task-record__ext">.otlp.json</span>
          </button>
        </div>}
      </div>}
    </header>
    <section className="v2-task-record__body" aria-labelledby="task-record-title">
      {!loaded && !error && <>
        <p className="v2-task-record__sr" role="status">{t('taskRecord.loading')}</p>
        <ol className="v2-task-record__list v2-task-record__list--loading" aria-hidden="true">
          {[0, 1, 2].map((n) => <li className="v2-task-record__e" key={n}>
            <span className="v2-task-record__row"><span className="v2-task-record__mk" /><span className="v2-task-record__bone" /></span>
          </li>)}
        </ol>
      </>}
      {error && <div className="v2-task-record__none" role="alert">
        <span className="v2-task-record__tile" aria-hidden="true">
          {error === 'access' || error === 'members' ? <ShellGlyph name="lock" /> : <ShellGlyph name="alert" />}
        </span>
        {error === 'access' && <h2>{t('taskRecord.unavailableTitle')}</h2>}
        <p>{t(`taskRecord.${error}`)}</p>
        {retryable && <button type="button" className="v2-task-record__key v2-task-record__key--soft" onClick={retry}>{t('taskRecord.retry')}</button>}
      </div>}
      {loaded && <>
        <h2 className="v2-task-record__task">{title || taskId}</h2>
        <p className="v2-task-record__id">{`${taskId} · ${counts}`}</p>
        {downloadError && <p className="v2-task-record__alert" role="alert">{t('taskRecord.downloadError')}</p>}
        {!lines.length && <div className="v2-task-record__none">
          <span className="v2-task-record__tile" aria-hidden="true"><RecordGlyph name="clock" /></span>
          <p>{t('taskRecord.empty')}</p>
        </div>}
        {days.map(({ day, entries }) => <React.Fragment key={`${day}-${entries[0].seq}`}>
          <div className="v2-task-record__day">{day}</div>
          <ol className="v2-task-record__list">
            {entries.map((line) => {
              const isOpen = open.has(line.seq);
              const moreId = `task-record-entry-${line.seq}`;
              const detail = summary(line);
              return <li className={`v2-task-record__e${isOpen ? ' v2-task-record__e--open' : ''}`} key={line.seq}>
                <button type="button" className="v2-task-record__row" aria-expanded={isOpen} aria-controls={isOpen ? moreId : undefined}
                  title={t('taskRecord.details')} onClick={() => toggle(line.seq)}>
                  <span className={`v2-task-record__mk${line.kind === 'task.done' ? ' v2-task-record__mk--done' : ''}`} aria-hidden="true"><KindMark kind={line.kind} /></span>
                  <span className="v2-task-record__main">
                    <b>{kindLabel(line.kind)}</b>
                    <span className="v2-task-record__who" title={actorLabel(line.actor)}>{actorMark(line.actor)}<span className="v2-task-record__name">{actorLabel(line.actor)}</span></span>
                    {detail && <span className="v2-task-record__d">{detail}</span>}
                  </span>
                  <time className="v2-task-record__t" dateTime={line.ts}>{clock(line.ts) || line.ts}</time>
                  <span className="v2-task-record__chev" aria-hidden="true"><ShellGlyph name="chevron" size={16} /></span>
                </button>
                {isOpen && <dl className="v2-task-record__more" id={moreId}>
                  <dt>{t('taskRecord.entryKey')}</dt><dd>{line.seq}</dd>
                  {Object.entries(line.data || {}).map(([key, value]) => <React.Fragment key={key}>
                    <dt>{key}</dt>{key === 'argsDigest' && typeof value === 'string' && shortDigest(value) !== value
                      ? <dd title={value}>{shortDigest(value)}</dd> : <dd>{valueLabel(key, value)}</dd>}
                  </React.Fragment>)}
                </dl>}
              </li>;
            })}
          </ol>
        </React.Fragment>)}
        {runId && <footer className="v2-task-record__foot"><code>{t('taskRecord.run', { id: runId })}</code></footer>}
      </>}
    </section>
  </div>;
};
export default V2TaskRecord;
