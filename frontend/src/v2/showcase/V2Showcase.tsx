import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import axios from 'axios';
import getApiBaseUrl from '../../utils/apiBaseUrl';
import V2Avatar from '../components/V2Avatar';
import V2MessageBubble from '../components/V2MessageBubble';
import { V2Message } from '../hooks/useV2PodDetail';
import '../v2.css';
import './v2-showcase.css';

// Public, logged-out, read-only window into a real Commonly room. A first-time
// visitor with NO account sees a live conversation between humans and agents and
// a "sign up to join" conversion path. This route sits OUTSIDE the V2RequireAuth
// gate (see V2App), so every fetch here MUST be token-less.
//
// Contract (shared with the backend showcase route):
//   GET /api/showcase/:podId           → { pod, members, agents }   (404 if not publicRead)
//   GET /api/showcase/:podId/messages  → { messages, hasMore }      (404 if not publicRead)
// Both endpoints serve ONLY publicRead pods and strip email / memory / persona.

// Token-less client. The default axios instance (utils/axiosConfig) carries a
// request interceptor that injects the bearer token from localStorage on every
// call — a logged-in viewer would leak Authorization to this public endpoint.
// A dedicated instance skips that interceptor entirely, so showcase fetches are
// always anonymous regardless of the viewer's auth state.
//
// Created lazily (NOT at module scope): V2App imports this module for routing,
// and calling axios.create() at import time would force every test that loads
// the app shell to provide a `create`-capable axios mock. The lazy singleton
// defers creation to the first fetch.
let _showcaseClient: ReturnType<typeof axios.create> | null = null;
const getShowcaseClient = () => {
  if (!_showcaseClient) _showcaseClient = axios.create({ baseURL: getApiBaseUrl() });
  return _showcaseClient;
};

// Refresh cadence for the conversation. Anonymous sockets are intentionally not
// supported, so freshness comes from a light poll rather than a live socket.
const POLL_INTERVAL_MS = 12000;
const MESSAGE_LIMIT = 50;

// TODO(showcase): point this at the curated public demo pod once it is seeded
// and toggled publicRead on each instance. Overridable per-deploy via
// REACT_APP_SHOWCASE_POD_ID; the placeholder simply renders the not-public
// state until a real id is supplied.
const DEFAULT_SHOWCASE_POD_ID =
  process.env.REACT_APP_SHOWCASE_POD_ID || '__SHOWCASE_POD_ID__';

interface ShowcasePod {
  id: string;
  name: string;
  description?: string;
  type: string;
  memberCount: number;
  createdAt: string;
}

interface ShowcaseMember {
  username: string;
  displayName?: string;
  profilePicture?: string | null;
  isBot: boolean;
  agentName?: string;
  instanceId?: string;
}

interface ShowcaseAgent {
  displayName: string;
  agentName: string;
  instanceId?: string;
  profilePicture?: string | null;
}

interface ShowcaseInfo {
  pod: ShowcasePod;
  members: ShowcaseMember[];
  agents: ShowcaseAgent[];
}

interface ShowcaseAttachment {
  fileName: string;
  kind: string;
}

interface ShowcaseMessage {
  id: string;
  author: {
    username: string;
    displayName?: string;
    profilePicture?: string | null;
    isBot: boolean;
  };
  content: string;
  createdAt: string;
  attachments?: ShowcaseAttachment[];
}

interface ShowcaseMessagesResponse {
  messages: ShowcaseMessage[];
  hasMore: boolean;
}

// Brand mark, mirrored from the landing page so the showcase front-door reads
// as the same product. Kept inline to avoid a shared-component dependency for a
// single 64×64 glyph.
const Mark: React.FC<{ size?: number }> = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    <path d="M 50 17.7 A 22 22 0 1 0 50 46.3" fill="none" stroke="currentColor" strokeWidth="9" strokeLinecap="round" />
    <circle cx="25" cy="32" r="2.4" fill="currentColor" />
    <circle cx="32" cy="32" r="2.4" fill="currentColor" />
    <circle cx="39" cy="32" r="2.4" fill="currentColor" />
  </svg>
);

// Adapt a showcase message to the V2Message shape so we can reuse V2MessageBubble
// verbatim — same avatar, displayName, markdown, and file-pill rendering as the
// authenticated chat. Attachments arrive as a structured array here (no inline
// tokens), so we re-encode them as [[file:…]] tokens the bubble already knows how
// to render. No handlers are passed, so the bubble is inert: no author click, no
// file open, no reactions — read-only by construction.
const toV2Message = (m: ShowcaseMessage): V2Message => {
  let content = m.content || '';
  if (Array.isArray(m.attachments) && m.attachments.length > 0) {
    const tokens = m.attachments
      .filter((a) => a && a.fileName)
      .map((a) => `[[file:${a.fileName}]]`)
      .join(' ');
    if (tokens) content = content ? `${content}\n\n${tokens}` : tokens;
  }
  return {
    id: m.id,
    pod_id: '',
    user_id: '',
    content,
    message_type: 'text',
    created_at: m.createdAt,
    createdAt: m.createdAt,
    user: {
      username: m.author.displayName || m.author.username,
      profile_picture: m.author.profilePicture || null,
    },
  };
};

type LoadState = 'loading' | 'ready' | 'not-public' | 'error';

const V2Showcase: React.FC = () => {
  const { podId: podIdParam } = useParams<{ podId: string }>();
  const podId = podIdParam || DEFAULT_SHOWCASE_POD_ID;

  const [state, setState] = useState<LoadState>('loading');
  const [info, setInfo] = useState<ShowcaseInfo | null>(null);
  const [messages, setMessages] = useState<ShowcaseMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const didInitialScrollRef = useRef(false);

  // Fetch the pod info + member/agent roster. Drives the load state: a 404 here
  // means the pod is missing OR not publicRead (the backend returns the same 404
  // for both — no oracle), which we render as the friendly "not public" state.
  const fetchInfo = useCallback(async (): Promise<boolean> => {
    try {
      const res = await getShowcaseClient().get<ShowcaseInfo>(`/api/showcase/${podId}`);
      setInfo(res.data);
      return true;
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      setState(status === 404 ? 'not-public' : 'error');
      return false;
    }
  }, [podId]);

  const fetchMessages = useCallback(async (): Promise<void> => {
    try {
      const res = await getShowcaseClient().get<ShowcaseMessagesResponse>(
        `/api/showcase/${podId}/messages`,
        { params: { limit: MESSAGE_LIMIT } },
      );
      setMessages(Array.isArray(res.data?.messages) ? res.data.messages : []);
      setHasMore(Boolean(res.data?.hasMore));
    } catch {
      // A transient message-fetch failure shouldn't blow away a room that
      // already loaded — keep the last good list and let the next poll retry.
    }
  }, [podId]);

  // Initial load: info first (gates everything), then the conversation.
  useEffect(() => {
    let cancelled = false;
    setState('loading');
    setInfo(null);
    setMessages([]);
    didInitialScrollRef.current = false;
    (async () => {
      const ok = await fetchInfo();
      if (cancelled || !ok) return;
      await fetchMessages();
      if (!cancelled) setState('ready');
    })();
    return () => { cancelled = true; };
  }, [fetchInfo, fetchMessages]);

  // Poll for freshness once the room is live. Cleaned up on unmount / pod change.
  useEffect(() => {
    if (state !== 'ready') return undefined;
    const id = window.setInterval(() => { fetchMessages(); }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [state, fetchMessages]);

  // Drop to the latest message once, on first successful render, so the visitor
  // lands on the freshest part of the conversation. Subsequent polls don't yank
  // the scroll position.
  useEffect(() => {
    if (state !== 'ready' || didInitialScrollRef.current || messages.length === 0) return;
    didInitialScrollRef.current = true;
    // Guard: jsdom (tests) and some non-DOM environments don't implement
    // scrollIntoView, so calling it unguarded throws inside this effect.
    if (typeof messagesEndRef.current?.scrollIntoView === 'function') {
      messagesEndRef.current.scrollIntoView({ block: 'end' });
    }
  }, [state, messages.length]);

  const topBar = (
    <header className="v2-showcase__bar">
      <Link className="v2-showcase__brand" to="/v2/landing" aria-label="Commonly home">
        <span className="v2-showcase__mark"><Mark size={24} /></span>
        <span className="v2-showcase__brand-name">Commonly</span>
      </Link>
      <nav className="v2-showcase__nav" aria-label="Primary">
        <Link className="v2-showcase__navlink" to="/v2/landing">What is Commonly?</Link>
        <Link className="v2-showcase__navlink" to="/v2/login">Sign in</Link>
        <Link className="v2-showcase__btn v2-showcase__btn--primary v2-showcase__btn--sm" to="/v2/register">
          Sign up to join
        </Link>
      </nav>
    </header>
  );

  if (state === 'loading') {
    return (
      <div className="v2-root v2-showcase">
        {topBar}
        <div className="v2-showcase__center">
          <span className="v2-spinner" />
        </div>
      </div>
    );
  }

  if (state === 'not-public' || state === 'error') {
    const isError = state === 'error';
    return (
      <div className="v2-root v2-showcase">
        {topBar}
        <div className="v2-showcase__center">
          <div className="v2-showcase__empty">
            <div className="v2-showcase__empty-title">
              {isError ? "This room couldn't be loaded" : "This room isn't public"}
            </div>
            <div className="v2-showcase__empty-text">
              {isError
                ? 'Something went wrong loading this conversation. Try again in a moment.'
                : 'It may have been made private or removed. Explore what Commonly is, or start your own room.'}
            </div>
            <div className="v2-showcase__empty-cta">
              <Link className="v2-showcase__btn v2-showcase__btn--primary" to="/v2/register">Start your own room</Link>
              <Link className="v2-showcase__btn v2-showcase__btn--ghost" to="/v2/landing">What is Commonly?</Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const pod = info?.pod;
  const agents = info?.agents || [];

  return (
    <div className="v2-root v2-showcase">
      {topBar}

      {/* Sticky conversion banner — the load-bearing CTA. Makes it obvious this
          is a real, live room and that the visitor can have one too. */}
      <div className="v2-showcase__banner" role="region" aria-label="Sign up to join Commonly">
        <span className="v2-showcase__banner-text">
          <span aria-hidden="true">👀 </span>
          A live look inside a Commonly room — sign up to start your own.
        </span>
        <span className="v2-showcase__banner-cta">
          <Link className="v2-showcase__btn v2-showcase__btn--primary v2-showcase__btn--sm" to="/v2/register">
            Sign up to join
          </Link>
          <Link className="v2-showcase__btn v2-showcase__btn--ghost v2-showcase__btn--sm" to="/v2/landing">
            What is Commonly?
          </Link>
        </span>
      </div>

      <main className="v2-showcase__main">
        {/* Room header — proves it's a real room with real members + agents. */}
        <section className="v2-showcase__room-head">
          <div className="v2-showcase__room-title">
            <span className="v2-showcase__room-mark" aria-hidden="true">
              {(pod?.name || '?').slice(0, 2).toUpperCase()}
            </span>
            <div>
              <h1 className="v2-showcase__room-name">{pod?.name || 'Commonly room'}</h1>
              <div className="v2-showcase__room-meta">
                {typeof pod?.memberCount === 'number' && (
                  <span>{pod.memberCount} member{pod.memberCount === 1 ? '' : 's'}</span>
                )}
                {agents.length > 0 && (
                  <span>· {agents.length} agent{agents.length === 1 ? '' : 's'}</span>
                )}
                <span className="v2-showcase__room-live">· Read-only view</span>
              </div>
            </div>
          </div>
          {agents.length > 0 && (
            <div className="v2-showcase__agents" aria-label="Agents in this room">
              {agents.slice(0, 6).map((a) => (
                <V2Avatar
                  key={`${a.agentName}:${a.instanceId || ''}`}
                  name={a.displayName || a.agentName}
                  src={a.profilePicture || undefined}
                  size="sm"
                  title={a.displayName || a.agentName}
                />
              ))}
              {agents.length > 6 && (
                <span className="v2-showcase__agents-more">+{agents.length - 6}</span>
              )}
            </div>
          )}
        </section>

        {pod?.description && (
          <p className="v2-showcase__room-desc">{pod.description}</p>
        )}

        {/* Conversation — read-only. No composer, no react/@mention controls,
            no identity inspector. V2MessageBubble with no handlers is inert. */}
        <section className="v2-showcase__messages">
          {hasMore && (
            <div className="v2-showcase__older-note">Earlier messages are hidden in this public view.</div>
          )}
          {messages.length === 0 ? (
            <div className="v2-showcase__empty">
              <div className="v2-showcase__empty-title">No messages yet</div>
              <div className="v2-showcase__empty-text">This room is quiet right now. Check back soon.</div>
            </div>
          ) : (
            messages.map((m) => (
              <V2MessageBubble key={m.id} message={toV2Message(m)} />
            ))
          )}
          <div ref={messagesEndRef} />
        </section>

        {/* Footer conversion card — reinforce that this is a real, ownable room. */}
        <section className="v2-showcase__footer-cta">
          <div className="v2-showcase__footer-title">This is a real Commonly room.</div>
          <div className="v2-showcase__footer-text">
            Bring your team and your agents into one shared memory. Start your own in minutes — it&apos;s open-source and free.
          </div>
          <div className="v2-showcase__empty-cta">
            <Link className="v2-showcase__btn v2-showcase__btn--primary" to="/v2/register">Sign up to join</Link>
            <Link className="v2-showcase__btn v2-showcase__btn--ghost" to="/v2/landing">What is Commonly?</Link>
          </div>
        </section>
      </main>
    </div>
  );
};

export default V2Showcase;
