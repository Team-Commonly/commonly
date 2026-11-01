import React, { createContext, useContext, useEffect, useState } from 'react';
import type { ElementNode } from '@openuidev/lang-core';
import { Link as RouterLink } from 'react-router-dom';
import { useV2Api } from '../hooks/useV2Api';
import { useSocket } from '../../context/SocketContext';
import { cardHref } from './cardLinks';
import ConnectorLogo from '../connectors/ConnectorLogo';

export const CardContext = createContext<{ podId: string; runId: string; runPodId?: string }>({ podId: '', runId: '' });
export type Node = ElementNode;
export const literal = (value: unknown) => value == null ? '' : String(value);
export function CardLink({ label, url, as = 'text', showHost = true }: { label: string; url: string; as?: string; showHost?: boolean }) {
  const parsed = cardHref(url);
  if (!parsed) return <span className="ui-meta">{label} · link unavailable</span>;
  return <a className={as === 'text' ? 'lk' : `ub${as === 'primary' ? ' f' : ''}`} href={parsed.href} target="_blank" rel="noopener noreferrer">
    {label}{showHost && <span className={as === 'text' ? 'lk-h' : 'h'}>{parsed.hostname}</span>}
  </a>;
}
export function TextView({ body, render }: { body: unknown; render?: (v: unknown) => React.ReactNode }) {
  return <p className="ui-tx">{Array.isArray(body) ? body.map((part, i) => <React.Fragment key={i}>{typeof part === 'string' ? part : render?.(part)}</React.Fragment>) : literal(body)}</p>;
}
export function BadgeView({ label, tone = 'neutral' }: { label: string; tone?: string }) {
  return <span className={`bd ${tone}`}>{label}</span>;
}
export function ListView({ items, ordered }: { items: unknown[]; ordered?: boolean }) {
  const Tag = ordered ? 'ol' : 'ul';
  return <Tag className="ui-ls">{items.map((item, i) => <li key={i}>{literal(item)}</li>)}</Tag>;
}
export function KeyValueView({ pairs }: { pairs: Array<{ key: string; value: unknown }> }) {
  return <dl className="ui-kv">{pairs.map((p, i) => <React.Fragment key={i}><dt>{p.key}</dt><dd>{literal(p.value)}</dd></React.Fragment>)}</dl>;
}
function StateGlyph({ state }: { state: string }) {
  return <svg className="gl" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    {state === 'done' ? <path d="m3 8 3 3 7-7" /> : state === 'failed' ? <path d="m4 4 8 8M12 4l-8 8" /> : state === 'skipped' ? <path d="M3 8h10" /> : <circle cx="8" cy="8" r="5" strokeDasharray={state === 'pending' ? '2 2' : undefined} />}
  </svg>;
}
export function StepsView({ steps }: { steps: Node[] }) {
  return <ol className="ui-steps">{steps.map((step, i) => <li className={String(step.props.state)} key={i}>
    <StateGlyph state={String(step.props.state)} /><span className="l">{literal(step.props.label)}</span>
    <span className="st">{literal(step.props.state)}</span>{step.props.detail && <span className="x">{literal(step.props.detail)}</span>}
  </li>)}</ol>;
}
export function DiffView({ files }: { files: Node[] }) {
  const sums = files.reduce((s, f) => [s[0] + Number(f.props.added), s[1] + Number(f.props.removed)], [0, 0]);
  const row = (path: string, added: number, removed: number) => <><span className="p"><bdi>{path}</bdi></span><span className="n"><b>+{added}</b> −{removed}</span>
    <span className="bar" aria-hidden="true">{Array.from({ length: 5 }, (_, i) => <span key={i} className={i < Math.round(5 * added / (added + removed || 1)) ? 'a' : added + removed ? 'r' : 'z'} />)}</span></>;
  return <ul className="ui-diff">{files.map((f, i) => <li key={i}>{row(literal(f.props.path), Number(f.props.added), Number(f.props.removed))}</li>)}<li className="tot">{row(`${files.length} files`, sums[0], sums[1])}</li></ul>;
}
export function TableView({ columns, rows }: { columns: Node[]; rows: unknown[][] }) {
  return <div className={columns.length > 2 ? 'ui-table ui-table--records' : 'ui-table'}>
    <div className="ui-tw"><table className="ui-tb"><thead><tr>{columns.map((col, i) => <th className={col.props.type === 'number' ? 'num' : ''} key={i}>{literal(col.props.label)}</th>)}</tr></thead>
      <tbody>{rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td className={columns[j]?.props.type === 'number' ? 'num' : ''} key={j}>{literal(cell)}</td>)}</tr>)}</tbody></table></div>
    {columns.length > 2 && <div className="ui-recs">{rows.map((row, i) => <dl className="ui-rec" key={i}>{row.map((cell, j) => <React.Fragment key={j}><dt className="ui-meta">{literal(columns[j].props.label)}</dt><dd>{literal(cell)}</dd></React.Fragment>)}</dl>)}</div>}
  </div>;
}
interface Task { taskId: string; title: string; status: string; }
export function TaskView({ taskId, note }: { taskId: string; note?: string }) {
  const { podId } = useContext(CardContext);
  const { socket, connected } = useSocket();
  const api = useV2Api();
  const [state, setState] = useState<{ key: string; task?: Task }>({ key: '' });
  const key = `${podId}/${taskId}`;
  useEffect(() => {
    let active = true; let sequence = 0;
    const load = () => {
      const request = ++sequence;
      api.get<{ tasks?: Task[] }>(`/api/v1/tasks/${encodeURIComponent(podId)}`).then(data => {
        if (active && request === sequence) setState({ key, task: data.tasks?.find(t => t.taskId === taskId) });
      }).catch(() => { if (active && request === sequence) setState({ key }); });
    };
    const updated = (event: { podId?: string } | null) => {
      if (event && (!event.podId || event.podId === podId)) load();
    };
    load();
    socket?.on('task_updated', updated);
    socket?.on('connect', load);
    return () => { active = false; socket?.off('task_updated', updated); socket?.off('connect', load); };
  }, [api, podId, taskId, key, socket, connected]);
  const task = state.key === key ? state.task : undefined;
  return <div className={`ui-task ${task?.status || ''}`}><span className="ui-meta" aria-hidden="true">·</span>
    <span className="ti">{task?.title || (state.key === key ? 'Task unavailable' : 'Loading task…')}</span><span className="id">{taskId}</span>
    <span className="no">{task?.status || ''}{note && ` · ${note}`}</span></div>;
}
const SOURCE_NAMES: Record<string, string> = { linear: 'Linear', sentry: 'Sentry', atlassian: 'Atlassian' };
/** "fetched 2 min ago"; a clock running behind the server reads as just now. */
export function fetchedLabel(ms: number) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'fetched just now';
  if (minutes < 60) return `fetched ${minutes} min ago`;
  if (minutes < 24 * 60) return `fetched ${Math.floor(minutes / 60)} h ago`;
  return `fetched ${Math.floor(minutes / (24 * 60))} d ago`;
}
/** Server-stamped origin (TASK-607). The write path refuses it from agents. */
export function SourceView({ connector, fetchedAt }: { connector: string; fetchedAt: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  const at = new Date(fetchedAt);
  return <span className="ui-src"><span className="ui-src-mk"><ConnectorLogo type={connector} size={16} /></span>
    <span className="ui-src-n">{SOURCE_NAMES[connector] || connector}</span><span aria-hidden="true">·</span>
    <time dateTime={fetchedAt} title={at.toLocaleString()}>{fetchedLabel(now - at.getTime())}</time></span>;
}
export function TraceLink() {
  const { podId: messagePodId, runPodId, runId } = useContext(CardContext);
  const podId = runPodId ?? messagePodId;
  return /^[a-f\d]{24}$/i.test(runId) && /^[a-f\d]{24}$/i.test(podId) ? <RouterLink className="lk" to={`/v2/pods/${encodeURIComponent(podId)}/runs/${runId}`}>Open trace</RouterLink> : <span className="ui-meta">Trace unavailable</span>;
}

interface TraceData {
  id: string; podId: string; startedAt: string; completedAt?: string;
  omittedToolCalls: number;
  turns: Array<{ toolCalls: Array<{ name: string; outcome: string; elapsedMs: number }> }>;
}
export function TraceView({ limit }: { limit: number }) {
  const { podId: messagePodId, runPodId, runId } = useContext(CardContext);
  const podId = runPodId ?? messagePodId;
  const api = useV2Api();
  const [state, setState] = useState<{ key: string; data?: TraceData }>({ key: '' });
  const key = `${podId}/${runId}`;
  const valid = /^[a-f\d]{24}$/i.test(podId) && /^[a-f\d]{24}$/i.test(runId);
  useEffect(() => {
    let active = true;
    if (!valid) return;
    api.get<{ run: TraceData }>(`/api/pods/${podId}/runs/${runId}`).then(({ run }) => {
      if (active && run.id === runId && run.podId === podId) setState({ key, data: run });
      else if (active) setState({ key });
    }).catch(() => { if (active) setState({ key }); });
    return () => { active = false; };
  }, [api, key, podId, runId, valid]);
  const data = state.key === key ? state.data : undefined;
  const calls = data?.turns.flatMap(turn => turn.toolCalls) || [];
  const elapsed = data?.completedAt ? Math.max(0, new Date(data.completedAt).getTime() - new Date(data.startedAt).getTime()) : null;
  const elapsedSeconds = elapsed === null ? null : Math.round(elapsed / 1000);
  return <div className="ui-rt"><div className="rh"><b>{data ? `run · ${calls.length + (data.omittedToolCalls || 0)} calls${elapsedSeconds === null ? '' : ` · ${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s`}` : 'Run trace'}</b><TraceLink /></div>
    {data ? <ul>{calls.slice(-Math.max(1, Math.min(5, limit))).map((call, i) => <li key={i}><span className="t">{call.name}</span><span className={`s${['failed', 'refused'].includes(call.outcome) ? ' x' : ''}`}>{call.outcome}</span><span className="d">{call.elapsedMs < 1000 ? `${call.elapsedMs}ms` : `${Math.round(call.elapsedMs / 1000)}s`}</span></li>)}</ul>
      : !valid || state.key === key ? <p className="ui-meta ui-trace-state">Trace unavailable</p> : <ul aria-label="Loading trace">{Array.from({ length: Math.max(1, Math.min(5, limit)) }, (_, i) => <li key={i} aria-hidden="true"><span className="ui-trace-skeleton" /></li>)}</ul>}
  </div>;
}
