import React, { Component, lazy, Suspense, useEffect, useState } from 'react';
import type { V2Message } from '../hooks/useV2PodDetail';
import { parseCard } from './uiCardSource';
import { CardContext, TraceLink } from './cardViews';
import './uiCard.css';

const Runtime = lazy(() => {
  // OpenUI's development entry auto-mounts an inspector by default. Commonly
  // intentionally uses only the headless renderer in every environment.
  (globalThis as Record<symbol, unknown>)[Symbol.for('openui.devtools.autoMount')] = true;
  return import('./cardRuntime');
});
class RenderBoundary extends Component<{ children: React.ReactNode; fallback: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
function CardBody({ message }: { message: V2Message }) {
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  const payload = message.payload;
  const valid = payload?.v === 1 && payload?.lang === 'openui@1' && !!parseCard(payload?.source);
  const expired = now >= new Date(message.created_at || message.createdAt || '').getTime() + 30 * 86400_000;
  const fallback = <><div className="ui-tx">{message.content}</div><p className="ui-meta">This card couldn’t be displayed.</p></>;
  if (expired) return <section className="ui gone"><div className="ui-bd"><p className="ui-tx">{message.content}</p><p className="ui-meta">Card expires after 30 days. Trace persists.</p><TraceLink /></div></section>;
  if (!valid || failed) return <div className="ui-fallback">{fallback}</div>;
  return <RenderBoundary fallback={fallback}><Suspense fallback={<div className="ui-tx">{message.content}</div>}>
    <Runtime source={payload!.source!} onError={() => setFailed(true)} />
  </Suspense></RenderBoundary>;
}
export default function V2UICard({ message, authorLabel, time }: { message: V2Message; authorLabel: string; time?: string }) {
  return <div className="v2-msg v2-ui-card" data-testid="ui-card">
    <div className="ui-meta">{authorLabel}{time && <> · <time>{time}</time></>}</div>
    <CardContext.Provider value={{ podId: message.pod_id, runId: message.payload?.runId || '' }}>
      <CardBody key={`${message.id}:${message.payload?.source}`} message={message} />
    </CardContext.Provider>
  </div>;
}
