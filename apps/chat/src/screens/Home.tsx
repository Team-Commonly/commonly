import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, type Integration, type Message, type Pod } from '@commonly/core';
import { useClient } from '../client';

const relative = (iso?: string) => {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

const authorOf = (m: Message) => m.user?.displayName || m.user?.username || m.username || 'Someone';
const isAgent = (m: Message) => Boolean(m.isBot || m.user?.isBot || m.user?.botMetadata);

/**
 * Screen three: what your agents did, and a place to tell them things.
 * The transcript is the workspace pod, live over the socket. Connectors
 * show as a line, not a settings page.
 */
export function Home() {
  const { client, session } = useClient();
  const [pod, setPod] = useState<Pod | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [connectors, setConnectors] = useState<Integration[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let off = () => {};
    (async () => {
      try {
        const ws = await client.pods.workspace(session.user?._id);
        setPod(ws);
        if (!ws) return;
        const [msgs, conns] = await Promise.all([client.pods.messages(ws._id, 40), client.connectors.list(ws._id)]);
        setMessages(msgs);
        setConnectors(conns.filter((c) => c.isActive !== false));
        await client.live.connect();
        client.live.joinPod(ws._id);
        off = client.live.on((ev) => {
          if (ev.type === 'newMessage' && String((ev.message as { podId?: unknown }).podId ?? ws._id) === String(ws._id)) {
            setMessages((prev) => (prev.some((m) => String(m.id) === String(ev.message.id)) ? prev : [...prev, ev.message]));
          }
        });
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not load your workspace.');
      }
    })();
    return () => off();
  }, [client, session.user?._id]);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!pod || !draft.trim()) return;
    setSending(true);
    try {
      const stored = await client.pods.send(pod._id, draft.trim());
      setMessages((prev) => (prev.some((m) => String(m.id) === String(stored.id)) ? prev : [...prev, stored]));
      setDraft('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Your message was not sent.');
    } finally {
      setSending(false);
    }
  };

  const connected = connectors.filter((c) => c.status === 'connected');
  const agents = messages.filter(isAgent);

  return (
    <div className="content stack stack--lg">
      <div className="row row--between row--wrap">
        <div className="stack" style={{ gap: 2 }}>
          <h1 className="title">{pod?.name || 'Your workspace'}</h1>
          <p className="meta">
            {connected.length
              ? `Connected to ${connected.map((c) => c.config?.chatTitle || c.type).join(', ')}.`
              : 'No channel connected yet.'}{' '}
            <Link to="/connect">{connected.length ? 'Manage channels' : 'Connect one'}</Link>
          </p>
        </div>
      </div>

      {error && <div className="alert alert--danger" role="alert">{error}</div>}

      <form className="composer" onSubmit={send}>
        <span className="label">Tell your agents</span>
        <textarea
          rows={2}
          placeholder="What's on your mind? Mention an agent with @ to wake it."
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send(); }}
          disabled={!pod || sending}
        />
        <div className="composer__foot">
          <span className="meta">Posts as {session.user?.displayName || session.user?.username || 'you'} · ⌘↵</span>
          <button type="submit" className="btn btn--primary btn--sm" disabled={!pod || sending || !draft.trim()}>Send</button>
        </div>
      </form>

      <section className="stack">
        <div className="topline">
          <h2 className="heading">What your agents did</h2>
          {agents.length > 0 && <span className="meta">{agents.length} updates</span>}
        </div>
        {messages.length === 0 ? (
          <p className="meta">Nothing yet. Say something above, or in your connected channel, and it shows up here.</p>
        ) : (
          <div className="rows">
            {messages.slice(-30).map((m) => (
              <article key={String(m.id)} className="rowitem">
                <span className={`mark${isAgent(m) ? ' mark--agent' : ''}`} aria-hidden="true">{isAgent(m) ? '✦' : '@'}</span>
                <div className="stack" style={{ gap: 2 }}>
                  <div className="topline">
                    <strong>{authorOf(m)}</strong>
                    <span className="meta">{relative(m.createdAt)}</span>
                  </div>
                  <p className="body">{m.content}</p>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
