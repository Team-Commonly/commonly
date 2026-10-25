import { useTranslation } from 'react-i18next';
import React, { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useV2Api } from '../hooks/useV2Api';
import V2PlaybookEditor from './V2PlaybookEditor';
import V2ApprovalCard from './V2ApprovalCard';
import type { V2Message } from '../hooks/useV2PodDetail';
import type { Playbook, PlaybookOptions, PlaybookRun } from './playbookTypes';

const errorText = (error: unknown) =>
  (error as { response?: { data?: { message?: string } } })?.response?.data?.message ||
  'Playbooks unavailable. Retry shortly.';
const Panel: React.FC<{ podId: string }> = ({ podId }) => {
  const { t } = useTranslation();
  const api = useV2Api();
  const { currentUser } = useAuth();
  const [books, setBooks] = useState<Playbook[]>([]);
  const [options, setOptions] = useState<PlaybookOptions | null>(null);
  const [selected, setSelected] = useState('');
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [runs, setRuns] = useState<PlaybookRun[]>([]);
  const [cards, setCards] = useState<V2Message[]>([]);
  const [gallery, setGallery] = useState<
    { id: string; title: string; description?: string; schedule?: unknown }[] | null
  >(null);
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState<string | null>(null);
  const requestId = useRef('');
  const alive = useRef(true);
  const sequence = useRef(0);
  const base = `/api/pods/${podId}/playbooks`;
  const book = books.find((row) => row.id === selected);
  const open = runs.some((run) => run.status !== 'done');
  const member = (role: string) => options?.members.find((row) => row.userId === bindings[role]);
  const label = (role: string) => member(role)?.label || member(role)?.handle || role;
  const refresh = async () => {
    const [response, opts] = await Promise.all([
      api.get<{ playbooks: Playbook[] }>(base),
      api.get<PlaybookOptions>(`${base}/options`),
    ]);
    if (!alive.current) return;
    setBooks(response.playbooks);
    setOptions(opts);
    setSelected((previous) =>
      response.playbooks.some((row) => row.id === previous)
        ? previous
        : response.playbooks[0]?.id || '',
    );
  };
  useEffect(() => {
    alive.current = true;
    void refresh()
      .catch((err) => {
        if (alive.current) setError(errorText(err));
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
    return () => {
      alive.current = false;
    };
  }, [base, api]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setBindings(book?.bindings || {});
    setInput(null);
  }, [book]);
  useEffect(() => {
    const version = ++sequence.current;
    setRuns([]);
    setCards([]);
    if (!selected) return undefined;
    const load = () =>
      api
        .get<{ runs: PlaybookRun[]; cards?: V2Message[] }>(`${base}/${selected}/runs`)
        .then((response) => {
          if (alive.current && sequence.current === version) {
            setRuns(response.runs);
            setCards(response.cards || []);
          }
        })
        .catch((err) => {
          if (alive.current && sequence.current === version) setError(errorText(err));
        });
    void load();
    const timer = window.setInterval(load, 15000);
    return () => {
      sequence.current += 1;
      window.clearInterval(timer);
    };
  }, [api, base, selected]);
  const mutate = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
      await refresh();
      if (selected) {
        const response = await api.get<{ runs: PlaybookRun[]; cards?: V2Message[] }>(
          `${base}/${selected}/runs`,
        );
        if (alive.current) {
          setRuns(response.runs);
          setCards(response.cards || []);
        }
      }
    } catch (err) {
      if (alive.current) setError(errorText(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return (
    <div className="v2-playbooks">
      <header>
        <div>
          <Link to={`/v2/pods/${podId}`}>{t('playbooks.ui.back')}</Link>
          <h1>{t('playbooks.ui.title')}</h1>
        </div>
        <button
          disabled={busy}
          onClick={() => {
            void mutate(async () => {
              const response = await api.get<{ playbooks: NonNullable<typeof gallery> }>(
                `${base}/gallery`,
              );
              setGallery(response.playbooks);
            });
          }}
        >
          {t('playbooks.ui.gallery')}
        </button>
      </header>
      {error && (
        <div role="alert">
          {error}{' '}
          <button
            onClick={() => {
              void mutate(refresh);
            }}
          >
            {t('playbooks.ui.retry')}
          </button>
        </div>
      )}
      {loading && <p role="status">{t('playbooks.ui.loading')}</p>}
      {gallery && (
        <section className="v2-playbooks__panel" aria-label="Seed gallery">
          <div className="v2-playbooks__bar">
            <h2>{t('playbooks.ui.start')}</h2>
            <button onClick={() => setGallery(null)}>{t('playbooks.ui.closeGallery')}</button>
          </div>
          <label>
            {t('playbooks.ui.timezone')}
            <input value={timezone} onChange={(event) => setTimezone(event.target.value)} />
          </label>
          <div className="v2-playbooks__gallery">
            {gallery.map((seed) => (
              <article key={seed.id}>
                <h3>{seed.title}</h3>
                <p>{seed.description}</p>
                <button
                  disabled={busy}
                  onClick={() => {
                    void mutate(async () => {
                      const result = await api.post<{ id: string }>(`${base}/gallery/${seed.id}`, {
                        timezone,
                      });
                      setSelected(result.id);
                      setGallery(null);
                    });
                  }}
                >
                  {t('playbooks.ui.use')}
                </button>
              </article>
            ))}
          </div>
        </section>
      )}
      {!loading && !books.length && <p>{t('playbooks.ui.empty')}</p>}
      <div className="v2-playbooks__layout">
        <nav aria-label="Pod playbooks">
          {books.map((row) => (
            <button
              key={row.id}
              aria-current={selected === row.id}
              disabled={busy}
              onClick={() => setSelected(row.id)}
            >
              {row.title}
              <small>
                {row.on ? 'On' : 'Off'} · {row.definition.steps.length} steps
              </small>
            </button>
          ))}
        </nav>
        {book && (
          <div className="v2-playbooks__detail">
            <div className="v2-playbooks__bar">
              <div>
                <h2>{book.title}</h2>
                <p>
                  {book.schedule
                    ? `${book.schedule.cron.split(' ')[4] === '*' ? t('playbooks.ui.daily') : book.schedule.cron.split(' ')[4] === '1-5' ? t('playbooks.ui.weekdays') : new Intl.DateTimeFormat(undefined, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 9, 25 + Number(book.schedule.cron.split(' ')[4]))))} · ${book.schedule.cron.split(' ')[1].padStart(2, '0')}:${book.schedule.cron.split(' ')[0].padStart(2, '0')} · ${book.schedule.timezone}`
                    : t('playbooks.ui.manualTrigger')}
                </p>
              </div>
              <div className="v2-playbooks__actions">
                <button
                  disabled={busy || (!book.on && !options?.enabled)}
                  onClick={() => {
                    void mutate(() =>
                      api.post(`${base}/${book.id}/state`, { on: !book.on, bindings }),
                    );
                  }}
                >
                  {t(book.on ? 'playbooks.ui.off' : 'playbooks.ui.on')}
                </button>
                <button
                  className="v2-playbooks__run"
                  disabled={busy || !book.on || !options?.enabled || open}
                  onClick={() => {
                    requestId.current = crypto.randomUUID();
                    setInput('');
                  }}
                >
                  {t('playbooks.ui.run')}
                </button>
              </div>
            </div>
            {!options?.enabled && <p>{t('playbooks.ui.disabled')}</p>}
            {book.error && <p role="alert">{book.error}</p>}
            <div className="v2-playbooks__form">
              {book.definition.roles.map((role) => (
                <label key={role.key}>
                  {role.key} · {role.kind}
                  <select
                    value={bindings[role.key] || ''}
                    disabled={busy || book.on || open}
                    onChange={(event) =>
                      setBindings({ ...bindings, [role.key]: event.target.value })
                    }
                  >
                    <option value="">{t('playbooks.ui.chooseMember')}</option>
                    {options?.members
                      .filter((row) => row.kind === role.kind)
                      .map((row) => (
                        <option key={row.userId} value={row.userId}>
                          {row.label || row.handle}
                          {row.runtime ? ` · ${row.runtime.toUpperCase()}` : ''}
                        </option>
                      ))}
                  </select>
                </label>
              ))}
            </div>
            {input !== null && (
              <section className="v2-playbooks__panel">
                <label>
                  {t('playbooks.ui.input')}
                  <textarea
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    maxLength={8000}
                  />
                </label>
                <div className="v2-playbooks__actions">
                  <button
                    disabled={busy}
                    onClick={() => {
                      void mutate(async () => {
                        await api.post(`${base}/${book.id}/run`, {
                          input,
                          requestId: requestId.current,
                        });
                        setInput(null);
                      });
                    }}
                  >
                    {t('playbooks.ui.startRun')}
                  </button>
                  <button disabled={busy} onClick={() => setInput(null)}>
                    {t('playbooks.ui.cancel')}
                  </button>
                </div>
              </section>
            )}
            <ol className="v2-playbooks__steps">
              {book.definition.steps.map((step, index) => (
                <li key={step.key}>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <div>
                    <h3>{step.title}</h3>
                    <p>{step.do}</p>
                    <small>
                      {step.writeGap && step.approval?.act === 'actor'
                        ? t('playbooks.ui.manualMeta', { person: label(step.role) })
                        : `${label(step.role)}${step.delivers ? ` · ${t(step.delivers === 'post' ? 'playbooks.ui.post' : 'playbooks.ui.pr')}` : ''}`}
                    </small>
                  </div>
                </li>
              ))}
            </ol>
            {options && (
              <V2PlaybookEditor
                key={`${book.id}:${book.sourceText}:${book.title}:${JSON.stringify(book.definition)}`}
                book={{ ...book, bindings }}
                options={options}
                disabled={busy || open}
                save={async (draft) => {
                  await mutate(() => api.put(`${base}/${book.id}`, draft));
                }}
              />
            )}
            <Link to={`/v2/pods/${podId}/board`}>{t('playbooks.ui.board')}</Link>
            {runs.map((run) => (
              <section className="v2-playbooks__panel" key={run.taskId}>
                <small>
                  Run {run.taskId} · {run.status}
                </small>
                <h3>{run.lastUpdate || 'Run in progress'}</h3>
                <ul>
                  {run.steps.map((step) => {
                    const definition = (run.definition || book.definition).steps.find(
                      (item) => item.key === step.key,
                    );
                    const person =
                      definition &&
                      (run.members?.find(
                        (person) => person.userId === run.bindings?.[definition.role],
                      ) ||
                        member(definition.role));
                    const canComplete =
                      step.guard === 'person' &&
                      person?.userId === currentUser?._id &&
                      ['pending', 'claimed'].includes(step.status) &&
                      (!step.ruling || step.ruling.state === 'approved');
                    return (
                      <li key={step.taskId}>
                        {step.title} · {step.status}
                        {step.ruling && ` · ${step.ruling.state}`}
                        {canComplete && (
                          <button
                            disabled={busy}
                            onClick={() => {
                              void mutate(() =>
                                api.post(`/api/v1/tasks/${podId}/${step.taskId}/complete`, {}),
                              );
                            }}
                          >
                            {t('playbooks.ui.markDone')}
                          </button>
                        )}
                        {step.ruling?.state === 'declined' &&
                          (currentUser?._id === book.onBy ||
                            (definition?.approval &&
                              member(definition.approval.by)?.userId === currentUser?._id)) && (
                            <button
                              disabled={busy}
                              onClick={() => {
                                void mutate(() =>
                                  api.post(`${base}/${book.id}/steps/${step.taskId}/ask-again`, {}),
                                );
                              }}
                            >
                              {t('playbooks.ui.askAgain')}
                            </button>
                          )}
                      </li>
                    );
                  })}
                </ul>
                {cards
                  .filter((card) => card.payload?.params?.runTaskId === run.taskId)
                  .map((card) => (
                    <V2ApprovalCard
                      key={card.id}
                      message={card}
                      authorLabel={String(card.payload?.agentName || 'agent')}
                      time={null}
                    />
                  ))}
                <h3>{t('playbooks.ui.done')}</h3>
                <ul className="v2-playbooks__checks">
                  {(run.definition || book.definition).done.map((check, i) => {
                    const runDefinition = run.definition || book.definition;
                    const index = runDefinition.steps.findIndex((step) => step.key === check.step);
                    const step = run.steps.find((item) => item.key === check.step);
                    const role = runDefinition.steps[index]?.role || '';
                    const person =
                      run.members?.find((person) => person.userId === run.bindings?.[role]) ||
                      member(role);
                    const passed =
                      check.check === 'approved'
                        ? step?.ruling?.state === 'approved'
                        : check.check === 'done'
                          ? step?.status === 'done'
                          : check.check === 'has-pr'
                            ? Boolean(step?.prUrl)
                            : Boolean(
                                person?.kind === 'person' && step?.completedBy === person.userId,
                              );
                    return (
                      <li key={i}>
                        <span>
                          {check.check === 'by-person'
                            ? t('playbooks.ui.markedDone', {
                                person: person?.label || person?.handle || t('playbooks.person'),
                              })
                            : check.says}
                        </span>
                        <small>{t(passed ? 'playbooks.ui.met' : 'playbooks.ui.notYet')}</small>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
const V2Playbooks: React.FC = () => {
  const { podId } = useParams();
  return podId ? <Panel key={podId} podId={podId} /> : null;
};
export default V2Playbooks;
