import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { characterAvatarFor } from '../utils/avatars';
import {
  FACE_NAMES,
  FIXTURE_PODS,
  GENERIC_REPLY,
  isHumanFace,
  type FaceKey,
  type FixtureAsk,
  type FixtureMessage,
  type FixtureOption,
  type FixturePod,
  type PodKey,
  type ScriptedStep,
} from './demoFixture';
import './demo-workspace.css';

/**
 * The landing hero demo (TASK-147, spec `docs/design/landing-demo/Demo.dc.html`
 * via #1841). An interactive fake of the workspace: four pods, a decision card
 * you can rule on, suggested prompts with timed replies, and free text. No
 * backend — every reply is scripted and delayed locally, and the demo says so
 * in its own footer.
 *
 * Two rules from the spec's README shape this file:
 *
 * 1. **Build from the real components, not the board's markup.** The decision
 *    card and the transcript rows below render the product's own class names
 *    (`.v2-decision-card*`, `.v2-msg*`), and faces come from the real kit via
 *    `characterAvatarFor`. What the demo cannot borrow is the behaviour: every
 *    real in-app component on this surface is wired to a pod id, a socket and
 *    an API, and a marketing page has none of those. So the *shell* is
 *    demo-scoped (`.v2-demo*`) and the *pieces that carry identity* are the
 *    product's.
 * 2. **Sample values only.** All copy in the demo comes from the fixture and
 *    is deliberately English-only, exactly as a screenshot in the README would
 *    be; the page's own copy stays translated.
 */

const START_POD: PodKey = 'launch';

/** Faces are deterministic kit output, so build them once at module load. */
const FACES: Record<FaceKey, string | null> = (Object.keys(FACE_NAMES) as FaceKey[])
  .reduce((acc, key) => {
    acc[key] = characterAvatarFor(`demo:${key}`, isHumanFace(key) ? 'human' : 'agent');
    return acc;
  }, {} as Record<FaceKey, string | null>);

const Face: React.FC<{ faceKey?: FaceKey; initial?: string; className?: string }> = ({
  faceKey, initial, className = 'v2-demo__face',
}) => {
  const src = faceKey ? FACES[faceKey] : null;
  if (src) return <img className={className} src={src} alt="" />;
  return <span className={`${className} v2-demo__face--initial`} aria-hidden="true">{initial || ''}</span>;
};

interface Typing { pod: PodKey; faceKey: FaceKey }

const DemoWorkspace: React.FC = () => {
  const [pod, setPod] = useState<PodKey>(START_POD);
  const [decided, setDecided] = useState<Partial<Record<PodKey, string>>>({});
  const [extra, setExtra] = useState<Record<PodKey, FixtureMessage[]>>(
    () => FIXTURE_PODS.reduce((acc, p) => { acc[p.key] = []; return acc; }, {} as Record<PodKey, FixtureMessage[]>),
  );
  const [used, setUsed] = useState<Record<string, boolean>>({});
  const [typing, setTyping] = useState<Typing | null>(null);
  const [draft, setDraft] = useState('');

  // Timestamps march forward from 09:31 the way the spec's `stamp()` does, so
  // a ruling is visibly later than the message it answers. A ref, not state:
  // it is read inside timers and never rendered on its own.
  const clock = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const stamp = () => {
    clock.current += 1;
    const minutes = 9 * 60 + 31 + clock.current;
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  };

  // A demo that keeps scheduling after the visitor has left the page is a
  // leak and, on a landing, an unmounted-setState warning in every consumer
  // that renders it in a test. Clear everything on unmount.
  useEffect(() => () => { timers.current.forEach(clearTimeout); timers.current = []; }, []);

  const later = useCallback((ms: number, fn: () => void) => {
    timers.current.push(setTimeout(fn, ms));
  }, []);

  const say = useCallback((target: PodKey, message: FixtureMessage) => {
    setTyping((current) => (current && current.pod === target ? null : current));
    setExtra((current) => ({ ...current, [target]: [...current[target], message] }));
  }, []);

  const agentSays = useCallback((target: PodKey, step: ScriptedStep) => {
    later(Math.max(0, step.delay - 900), () => {
      setTyping({ pod: target, faceKey: step.faceKey });
    });
    later(step.delay, () => {
      say(target, {
        who: FACE_NAMES[step.faceKey],
        faceKey: step.faceKey,
        meta: stamp(),
        text: step.text,
        sub: step.sub,
      });
    });
  }, [later, say]);

  const send = useCallback((target: PodKey, raw: string, steps?: ScriptedStep[]) => {
    const text = raw.trim();
    if (!text) return;
    say(target, { who: 'Sam', faceKey: 'sam', meta: stamp(), text });
    const chain = steps || [{ faceKey: FIXTURE_PODS.find((p) => p.key === target)!.lead, text: GENERIC_REPLY, delay: 1500 }];
    chain.forEach((step) => agentSays(target, step));
  }, [agentSays, say]);

  const rule = useCallback((target: PodKey, ask: FixtureAsk, option: FixtureOption) => {
    setDecided((current) => ({ ...current, [target]: option.id }));
    say(target, { who: 'Sam', faceKey: 'sam', meta: stamp(), text: option.rule });
    agentSays(target, { faceKey: ask.faceKey, text: option.reply, delay: 1200 });
  }, [agentSays, say]);

  const activePod = useMemo(() => FIXTURE_PODS.find((p) => p.key === pod) as FixturePod, [pod]);
  const ruled = Boolean(decided[pod]);
  const pendingAsk = activePod.ask && !ruled ? activePod.ask : null;

  const statusOf = (agent: FixturePod['agents'][number]) => ({
    status: ruled && agent.ruledStatus ? agent.ruledStatus : agent.status,
    working: ruled && agent.ruledWorking !== undefined ? agent.ruledWorking : Boolean(agent.working),
    waiting: ruled && agent.ruledWaiting !== undefined ? agent.ruledWaiting : Boolean(agent.waiting),
  });
  const workingCount = activePod.agents.filter((a) => statusOf(a).working).length;
  const workingLabel = workingCount
    ? `● ${workingCount} ${workingCount === 1 ? 'agent working' : 'agents working'}`
    : 'no one working';

  const messages = [...activePod.base, ...extra[pod]];
  const chips = activePod.chips.filter((c) => !used[c.id]);

  const selectPod = (key: PodKey) => { setPod(key); setDraft(''); };

  return (
    <div className="v2-demo">
      <div className="v2-demo__stage">
        {/* rail — decorative chrome, so it stays out of the a11y tree */}
        <div className="v2-demo__rail" aria-hidden="true">
          <span className="v2-demo__mark">C</span>
          <span className="v2-demo__rail-slot v2-demo__rail-slot--on" />
          <span className="v2-demo__rail-slot" />
          <span className="v2-demo__rail-slot" />
          <span className="v2-demo__rail-slot" />
          <span className="v2-demo__rail-me"><Face faceKey="priya" /></span>
        </div>

        <nav className="v2-demo__pods" aria-label="Sample pods">
          <div className="v2-demo__label">pods</div>
          {FIXTURE_PODS.map((p) => {
            const showGroup = FIXTURE_PODS.find((x) => x.key === p.key)!.group
              !== FIXTURE_PODS[FIXTURE_PODS.indexOf(p) - 1]?.group;
            const needs = Boolean(p.ask && !decided[p.key]);
            const on = p.key === pod;
            return (
              <React.Fragment key={p.key}>
                {showGroup && <div className="v2-demo__group">{p.group}</div>}
                <button
                  type="button"
                  className={`v2-demo__pod${on ? ' v2-demo__pod--active' : ''}`}
                  aria-current={on ? 'true' : undefined}
                  onClick={() => selectPod(p.key)}
                >
                  <span className="v2-demo__pod-name">{p.name}</span>
                  {needs && <span className="v2-demo__pod-count">1</span>}
                </button>
              </React.Fragment>
            );
          })}
          <div className="v2-demo__label v2-demo__label--direct">direct</div>
          <div className="v2-demo__dm"><Face faceKey="wren" className="v2-demo__dm-face" />Wren</div>
          <div className="v2-demo__dm"><Face faceKey="kai" className="v2-demo__dm-face" />Kai</div>
          <div className="v2-demo__sample">sample workspace · replies are scripted</div>
        </nav>

        <section className="v2-demo__thread">
          <header className="v2-demo__thread-head">
            <div className="v2-demo__thread-title">
              <h3>{activePod.name}</h3>
              <span className="v2-demo__thread-sub">{activePod.sub}</span>
            </div>
            <div className="v2-demo__thread-meta">
              <span className="v2-demo__working">{workingLabel}</span>
              <span className="v2-demo__channel-inline">{activePod.channel}</span>
            </div>
          </header>

          <div
            className="v2-demo__log"
            role="log"
            aria-live="polite"
            aria-label={`Sample thread in ${activePod.name}`}
          >
            <div className="v2-demo__log-inner">
              {messages.map((m, i) => (
                <div className="v2-msg v2-demo__msg" key={`${m.who}-${m.meta}-${i}`}>
                  <Face faceKey={m.faceKey} initial={m.initial} />
                  <div className="v2-demo__msg-body">
                    <div className="v2-demo__msg-head">
                      <strong>{m.who}</strong>
                      <span className="v2-demo__meta">{m.meta}</span>
                    </div>
                    <div className="v2-demo__msg-text">{m.text}</div>
                    {m.sub && <div className="v2-demo__sub">{m.sub}</div>}
                  </div>
                </div>
              ))}

              {pendingAsk && (
                // The product's own card classes: this is the same card an
                // agent's DecisionRequest renders in the app, with a scripted
                // outcome. "Other…" is a canned ruling here rather than an
                // input, because the demo has nothing to send it to.
                <article className="v2-decision-card v2-demo__card">
                  <div className="v2-decision-card__head">
                    <span className="v2-decision-card__agent">{pendingAsk.who} needs you</span>
                    <span className="v2-demo__pulse">decision</span>
                  </div>
                  <p className="v2-decision-card__question">{pendingAsk.text}</p>
                  <div className="v2-decision-card__options">
                    {pendingAsk.options.map((option, index) => (
                      <button
                        type="button"
                        key={option.id}
                        className={index === 0
                          ? 'v2-decision-card__choice v2-decision-card__choice--primary'
                          : 'v2-decision-card__choice'}
                        onClick={() => rule(pod, pendingAsk, option)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </article>
              )}

              {typing && typing.pod === pod && (
                <div className="v2-demo__typing" role="status">
                  <Face faceKey={typing.faceKey} />
                  <span className="v2-demo__typing-label">
                    <span className="v2-demo__pulse v2-demo__pulse--dot" aria-hidden="true" />
                    {FACE_NAMES[typing.faceKey]} is working
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className="v2-demo__composer-wrap">
            {chips.length > 0 && (
              <div className="v2-demo__chips">
                <span className="v2-demo__label">try</span>
                {chips.map((chip) => (
                  <button
                    type="button"
                    key={chip.id}
                    className="v2-demo__chip"
                    onClick={() => {
                      setUsed((current) => ({ ...current, [chip.id]: true }));
                      send(pod, chip.text, chip.steps(ruled));
                    }}
                  >
                    {chip.text}
                  </button>
                ))}
              </div>
            )}
            <form
              className="v2-demo__composer"
              onSubmit={(event) => {
                event.preventDefault();
                const value = draft;
                setDraft('');
                send(pod, value);
              }}
            >
              <label className="v2-demo__sr" htmlFor="v2-demo-draft">Message {activePod.name}</label>
              <input
                id="v2-demo-draft"
                className="v2-demo__input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={`Message ${activePod.name}…  @ an agent to wake it`}
                autoComplete="off"
              />
              <span className="v2-demo__enter" aria-hidden="true">↵</span>
              <button type="submit" className="v2-demo__send">Send</button>
            </form>
          </div>
        </section>

        <aside className="v2-demo__inspector">
          <div className="v2-demo__panel">
            <div className="v2-demo__label">agents in {activePod.name.toLowerCase()}</div>
            {activePod.agents.map((agent) => {
              const state = statusOf(agent);
              return (
                <div className="v2-demo__agent" key={agent.faceKey}>
                  <Face faceKey={agent.faceKey} />
                  <div className="v2-demo__agent-body">
                    <div className="v2-demo__agent-name">{FACE_NAMES[agent.faceKey]}</div>
                    <div className={`v2-demo__agent-status${state.waiting ? ' v2-demo__agent-status--waiting' : ''}`}>
                      {state.status}
                    </div>
                  </div>
                  <span
                    className={`v2-demo__dot${state.working ? ' v2-demo__pulse' : ''}`}
                    data-state={state.working || state.waiting ? 'on' : 'off'}
                    aria-hidden="true"
                  />
                </div>
              );
            })}
          </div>

          <div className={`v2-demo__panel v2-demo__needs${pendingAsk ? ' v2-demo__needs--pending' : ''}`}>
            <div className="v2-demo__label">needs you</div>
            {pendingAsk ? (
              <div className="v2-demo__needs-row">
                <span>{pendingAsk.title}</span>
                <span className="v2-demo__needs-who">{pendingAsk.who.toLowerCase()}</span>
              </div>
            ) : (
              <div className="v2-demo__muted">Nothing. Your agents are working.</div>
            )}
          </div>

          <div className="v2-demo__panel">
            <div className="v2-demo__label">board · today</div>
            {activePod.board.map((row) => {
              const state = row.needsYou && !ruled ? 'needs you' : (ruled && row.ruledState ? row.ruledState : row.state);
              const accent = row.needsYou && !ruled;
              return (
                <div className="v2-demo__board-row" key={row.title}>
                  <span className="v2-demo__board-title">{row.title}</span>
                  <span className={`v2-demo__board-state${accent ? ' v2-demo__board-state--accent' : ''}`}>{state}</span>
                </div>
              );
            })}
          </div>

          <div className="v2-demo__panel">
            <div className="v2-demo__label">channel</div>
            {activePod.linked ? (
              <div className="v2-demo__channel">
                <span className="v2-demo__channel-dot" aria-hidden="true" />
                <span>{activePod.channelName}</span>
                <span className="v2-demo__channel-count">{activePod.channelCount}</span>
              </div>
            ) : (
              <div className="v2-demo__needs-who">+ Connect Slack or Telegram</div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
};

export default DemoWorkspace;
