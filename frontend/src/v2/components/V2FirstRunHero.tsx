import React, {
  useCallback, useEffect, useRef, useState,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { useV2Api } from '../hooks/useV2Api';
import { useTranslation } from 'react-i18next';
import { FIRST_RUN_REOPEN_EVENT, FIRST_RUN_STARTED_KEY } from '../firstRunGuide';

const POLL_INTERVAL_MS = 3_000;
const CHECK_MARK = '✓';
const EXTERNAL_LINK_MARK = '↗';
export { FIRST_RUN_STARTED_KEY } from '../firstRunGuide';

interface ConnectedAgent {
  agentName: string;
  instanceId: string;
  podId: string;
}

export interface AgentConnectionStatus {
  issued: boolean;
  connected: boolean;
  lastUsedAt: string | null;
  connectedAgent: ConnectedAgent | null;
}


const readFlag = (key: string): boolean => {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
};

const writeFlag = (key: string, value: boolean): void => {
  try {
    if (value) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  } catch {
    // Storage can be unavailable in private/sandboxed contexts. The current
    // render still behaves correctly; only persistence is lost.
  }
};

const StepMark: React.FC<{ done: boolean; children: React.ReactNode }> = ({ done, children }) => (
  <span className={`v2-first-run__step-mark${done ? ' v2-first-run__step-mark--done' : ''}`} aria-hidden="true">
    {done ? CHECK_MARK : children}
  </span>
);

interface V2FirstRunHeroProps {
  onVisibilityChange?: (visible: boolean) => void;
}

const V2FirstRunHero: React.FC<V2FirstRunHeroProps> = ({ onVisibilityChange }) => {
  const { t } = useTranslation();
  const api = useV2Api();
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  // `engaged` is a session latch. Once a zero-install user sees the hero, an
  // install appearing during the poll must advance the card to Waiting / Say
  // hello rather than make it disappear mid-flow. The persisted started flag
  // carries that latch across the BYO setup tab and a page reload.
  const [engaged, setEngaged] = useState(() => readFlag(FIRST_RUN_STARTED_KEY));
  const [status, setStatus] = useState<AgentConnectionStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [openingRoom, setOpeningRoom] = useState(false);
  const [roomError, setRoomError] = useState<string | null>(null);

  const pollStatus = useCallback(async () => {
    try {
      const next = await api.get<AgentConnectionStatus>('/api/users/me/agent-connection');
      setStatus(next);
      setStatusError(null);
    } catch {
      setStatusError(t('firstRun.errors.statusUnavailable'));
    }
  }, [api, t]);

  // The guide opens when someone asks for it (Feedback, then Guide), or when
  // a setup it started is still in progress (the persisted started latch). It
  // no longer opens on its own for a person with no agent: since the first
  // session's direction B (ruled 2026-10-15), Scout's welcome offers "Connect
  // an agent I already use" in the pod itself, and a modal over that offer
  // would put a second, heavier connect path on top of the first screen. With
  // nothing re-offering the guide, a stored skip and its expiry had nothing
  // left to suppress, so Skip simply ends the setup in progress.
  const shouldProbe = engaged;
  const visible = engaged;

  /** Every dismissal persists; Feedback → Guide saves the latch and returns to the shell. */
  const close = useCallback(() => {
    writeFlag(FIRST_RUN_STARTED_KEY, false);
    setEngaged(false);
  }, []);

  useEffect(() => {
    const reopen = () => {
      // Asking for the guide starts a setup: the started latch is the one
      // visibility model for new and connected users alike.
      writeFlag(FIRST_RUN_STARTED_KEY, true);
      setEngaged(true);
      setStatusError(null);
      setRoomError(null);
    };
    window.addEventListener(FIRST_RUN_REOPEN_EVENT, reopen);
    return () => window.removeEventListener(FIRST_RUN_REOPEN_EVENT, reopen);
  }, []);

  useEffect(() => {
    onVisibilityChange?.(shouldProbe);
  }, [onVisibilityChange, shouldProbe]);

  useEffect(() => {
    if (!shouldProbe || status?.connected) return undefined;

    let active = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const run = () => {
      if (!active) return;
      void pollStatus();
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const start = (immediate: boolean) => {
      stop();
      if (document.visibilityState === 'hidden') return;
      if (immediate) run();
      timer = setInterval(run, POLL_INTERVAL_MS);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') stop();
      else start(true);
    };

    // The first mount checks immediately. A state-driven effect restart (for
    // example issued:false arriving) only replaces the interval; firing again
    // here would duplicate every initial status request.
    start(status === null);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      active = false;
      stop();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [pollStatus, shouldProbe, status?.connected]);

  useEffect(() => {
    if (!visible) return undefined;

    const dialog = dialogRef.current;
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    dialog?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;

      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ));
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [close, visible]);

  if (!visible) return null;

  const openSetup = () => {
    writeFlag(FIRST_RUN_STARTED_KEY, true);
    setEngaged(true);
  };

  const sayHello = async () => {
    const agent = status?.connectedAgent;
    if (!agent || openingRoom) return;
    setOpeningRoom(true);
    setRoomError(null);
    try {
      const data = await api.post<{ room?: { _id?: string } }>('/api/agents/runtime/room', {
        agentName: agent.agentName,
        instanceId: agent.instanceId,
        podId: agent.podId,
      });
      const roomId = data.room?._id;
      if (!roomId) throw new Error('Agent room not returned');
      // Completion ends the setup, the same way Skip does — in state as well as
      // storage. The card is mounted above the route, so navigating does not
      // unmount it: ending only the stored flag left it over the new room,
      // stuck on "Opening…" and covering the message box (#2192).
      writeFlag(FIRST_RUN_STARTED_KEY, false);
      setEngaged(false);
      setOpeningRoom(false);
      navigate(`/v2/pods/${roomId}`);
    } catch (error) {
      const message = (error as { response?: { data?: { message?: string } } })
        ?.response?.data?.message;
      setRoomError(message || t('firstRun.errors.roomFailed'));
      setOpeningRoom(false);
    }
  };

  return (
    <div className="v2-first-run__overlay" onMouseDown={close}>
      <section
        ref={dialogRef}
        className="v2-first-run"
        role="dialog"
        aria-modal="true"
        aria-labelledby="v2-first-run-title"
        aria-describedby="v2-first-run-description"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="v2-first-run__eyebrow">{t('firstRun.eyebrow')}</div>
        <div className="v2-first-run__heading-row">
          <div>
            <h2 id="v2-first-run-title" className="v2-first-run__title">{t('firstRun.title')}</h2>
            <p id="v2-first-run-description" className="v2-first-run__lede">
              {t('firstRun.lede')}
            </p>
          </div>
          <button type="button" className="v2-first-run__skip" onClick={close}>{t('firstRun.skip')}</button>
        </div>

        <ol className="v2-first-run__steps">
          <li className="v2-first-run__step">
            <StepMark done={Boolean(status?.issued)}>1</StepMark>
            <div className="v2-first-run__step-body">
              <strong>{t('firstRun.steps.connect.title')}</strong>
              <span>{t('firstRun.steps.connect.text')}</span>
              {!status?.issued && (
                <a
                  className="v2-first-run__setup"
                  href="/v2/agents/byo"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={openSetup}
                >
                  {t('firstRun.steps.connect.openSetup')}
                  <span aria-hidden="true">{EXTERNAL_LINK_MARK}</span>
                </a>
              )}
            </div>
          </li>

          <li className="v2-first-run__step">
            <StepMark done={Boolean(status?.connected)}>2</StepMark>
            <div className="v2-first-run__step-body">
              <strong>{status?.connected ? t('firstRun.steps.start.connected') : t('firstRun.steps.start.title')}</strong>
              <span className={status?.connected ? 'v2-first-run__connected' : ''} role="status" aria-live="polite">
                {status?.connected ? t('firstRun.steps.start.connectedStatus') : t('firstRun.steps.start.waiting')}
              </span>
              {statusError && <span className="v2-first-run__error">{statusError}</span>}
            </div>
          </li>

          <li className="v2-first-run__step">
            <StepMark done={false}>3</StepMark>
            <div className="v2-first-run__step-body">
              <strong>{t('firstRun.steps.hello.title')}</strong>
              <span>{t('firstRun.steps.hello.text')}</span>
              {status?.connected && status.connectedAgent && (
                <button
                  type="button"
                  className="v2-first-run__hello"
                  onClick={sayHello}
                  disabled={openingRoom}
                >
                  {openingRoom ? t('firstRun.steps.hello.opening') : t('firstRun.steps.hello.cta')}
                </button>
              )}
              {roomError && <span className="v2-first-run__error">{roomError}</span>}
            </div>
          </li>
        </ol>
      </section>
    </div>
  );
};

export default V2FirstRunHero;
