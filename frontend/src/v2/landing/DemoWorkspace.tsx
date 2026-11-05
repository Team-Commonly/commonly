import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import V2Avatar from '../components/V2Avatar';
import V2Fold from '../components/V2Fold';
import V2Segmented from '../components/V2Segmented';
import V2ThemeSwitch from '../components/V2ThemeSwitch';
import { ShellGlyph } from '../icons/glyphs';
import { podInitials } from '../lib/podRecency';
import {
  FACE_NAMES,
  FIXTURE_PODS,
  GENERIC_REPLY,
  isHumanFace,
  type AgentState,
  type FaceKey,
  type FixtureAsk,
  type FixtureMessage,
  type FixtureOption,
  type FixturePod,
  type PodKey,
  type ScriptedStep,
} from './demoFixture';
// The app's own surface sheets, in V2App's order. v2.css is in the entry bundle
// already; these are what make the classes below draw as they do in a pod.
import '../primitives/primitives.css';
import '../chat/chat-message.css';
import '../chat/chat-pane.css';
import '../chat/chat-composer.css';
import '../chat/chat-inspector.css';
import './demo-workspace.css';

/**
 * The landing hero demo (TASK-147, spec `docs/design/landing-demo/Demo.dc.html`
 * via #1841). An interactive fake of the workspace: four pods, a decision card
 * you can rule on, suggested prompts with timed replies, and free text. No
 * backend — every reply is scripted and delayed locally, and the demo says so
 * in its own chrome.
 *
 * Two rules from the spec's README shape this file:
 *
 * 1. **Build from the real components, not the board's markup.** Every piece
 *    below renders the product's own class names and the shell's own leaf
 *    components (`V2Avatar`, `V2Segmented`, `V2Fold`, `V2ThemeSwitch`), so a
 *    change to the app reaches the hero without a copy to chase. What the demo
 *    cannot borrow is the wired containers (`V2Thread`, `V2Inspector`,
 *    `V2PodsSidebar`, `V2NavRail`): each needs a pod id, a socket, an API. So
 *    this file holds their markup with fixture data, and `.v2-demo*` holds only
 *    the layout and the places a phone hero differs from a phone app.
 * 2. **Sample values only.** Thread content comes from the fixture and stays
 *    English, as people's messages do; chrome uses the app's locale keys.
 *
 * Controls the demo has nothing behind (search, new pod, Invite, the panel's
 * keys, the rail) sit in `inert` wrappers: they draw as the app does and stay
 * out of the tab order and the accessibility tree.
 */

const START_POD: PodKey = 'launch';

const INERT = { 'aria-hidden': true, inert: '' } as React.HTMLAttributes<HTMLElement>;

/** V2NavRail's glyphs, in its order. The rail itself needs a router and a session. */
const RAIL_GLYPHS = [
  'M3 7l9-4 9 4-9 4-9-4zM3 12l9 4 9-4M3 17l9 4 9-4',
  'M12 1v6m0 8v6M5 5l4 4M15 15l4 4M1 12h6m8 0h6M5 19l4-4M15 9l4-4',
  'M22 12h-4l-3 9-6-18-3 9H2',
  'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M9 13h6M9 17h6',
  'M9 2v6M15 2v6M6 8h12v3a6 6 0 01-6 6 6 6 0 01-6-6V8zM12 17v5',
  'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12a7 7 0 00-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 00-2-1.2L14 3h-4l-.5 2.6a7 7 0 00-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 005 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 002 1.2L10 21h4l.5-2.6a7 7 0 002-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z',
];

const RailGlyph = ({ d }: { d: string }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

const Face: React.FC<{ faceKey?: FaceKey; initial?: string; size?: 'sm' | 'md'; className?: string }> = ({
  faceKey, initial, size = 'md', className = 'v2-demo__face',
}) => (faceKey ? (
  <V2Avatar
    name={FACE_NAMES[faceKey]}
    seed={`demo:${faceKey}`}
    kind={isHumanFace(faceKey) ? 'human' : 'agent'}
    size={size}
    tone="flat"
    className={className}
  />
) : (
  <V2Avatar name={initial} size={size} tone="flat" className={`${className} v2-demo__face--initial`} />
));

/** `@handle` draws as the app's mention chip; the rest of the line is plain. */
const MessageText: React.FC<{ text: string }> = ({ text }) => (
  <p>
    {text.split(/(@[a-z][\w-]*)/i).map((part, index) => (
      // eslint-disable-next-line react/no-array-index-key
      part.startsWith('@') ? <span className="v2-msg__mention" key={index}>{part}</span> : part
    ))}
  </p>
);

/** The fixture is typed in English time; a zh-CN reader gets the app's 上午 form. */
const localTime = (meta: string, language: string): string => (
  language.startsWith('zh')
    ? meta.replace(/(\d{1,2}:\d{2}) AM/, '上午$1').replace(/(\d{1,2}:\d{2}) PM/, '下午$1')
    : meta
);

const lastMinute = (pod: FixturePod): number => {
  const [, hour = '9', minute = '0'] = pod.base[pod.base.length - 1].meta.match(/(\d{1,2}):(\d{2})/) || [];
  return Number(hour) * 60 + Number(minute);
};

type FoldKey = 'needs' | 'agents' | 'board' | 'files' | 'join';

const Fold: React.FC<{
  id: FoldKey;
  icon: React.ComponentProps<typeof ShellGlyph>['name'];
  label: string;
  count?: number;
  open: boolean;
  onToggle: (id: FoldKey) => void;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}> = ({ id, icon, label, count = 0, open, onToggle, trailing, children }) => (
  <section className={`v2-workspace-inspector__card v2-workspace-inspector__group${open ? ' v2-workspace-inspector__group--open' : ''}`}>
    <h4 className="v2-workspace-inspector__label">
      <button
        type="button"
        className="v2-workspace-inspector__fold"
        aria-expanded={open}
        aria-controls={`v2-demo-fold-${id}`}
        onClick={() => onToggle(id)}
      >
        <span className="v2-workspace-inspector__fold-icon"><ShellGlyph name={icon} /></span>
        <span className="v2-workspace-inspector__fold-label">{label}</span>
        {count > 0 && <span className="v2-workspace-inspector__fold-count">{count}</span>}
        {trailing}
        <span className="v2-workspace-inspector__fold-chevron"><ShellGlyph name="chevron" /></span>
      </button>
    </h4>
    <V2Fold open={open} id={`v2-demo-fold-${id}`} className="v2-workspace-inspector__group-body">{children}</V2Fold>
  </section>
);

interface Typing { pod: PodKey; faceKey: FaceKey }

const DemoWorkspace: React.FC = () => {
  const { t, i18n } = useTranslation();
  const [pod, setPod] = useState<PodKey>(START_POD);
  const [decided, setDecided] = useState<Partial<Record<PodKey, string>>>({});
  const [extra, setExtra] = useState<Record<PodKey, FixtureMessage[]>>(
    () => FIXTURE_PODS.reduce((acc, p) => { acc[p.key] = []; return acc; }, {} as Record<PodKey, FixtureMessage[]>),
  );
  const [used, setUsed] = useState<Record<string, boolean>>({});
  const [typing, setTyping] = useState<Typing | null>(null);
  const [draft, setDraft] = useState('');
  const [listView, setListView] = useState<'recent' | 'all' | 'pinned'>('recent');
  const [panelView, setPanelView] = useState<'pod' | 'threads'>('pod');
  const [folds, setFolds] = useState<Record<FoldKey, boolean>>({
    needs: true, agents: true, board: false, files: false, join: false,
  });
  const cardRef = useRef<HTMLElement | null>(null);

  // Timestamps march forward from the pod's last message the way the spec's
  // `stamp()` does, so a ruling is visibly later than the message it answers. A
  // ref, not state: it is read inside timers and never rendered on its own.
  const clock = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const stamp = (target: PodKey) => {
    clock.current += 1;
    const minutes = lastMinute(FIXTURE_PODS.find((p) => p.key === target) as FixturePod) + 10 + clock.current;
    const hour = Math.floor(minutes / 60);
    return `${hour % 12 || 12}:${String(minutes % 60).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
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
        meta: stamp(target),
        text: step.text,
        sub: step.sub,
      });
    });
  }, [later, say]);

  const send = useCallback((target: PodKey, raw: string, steps?: ScriptedStep[]) => {
    const text = raw.trim();
    if (!text) return;
    say(target, { who: 'Sam', faceKey: 'sam', meta: stamp(target), text });
    const chain = steps || [{ faceKey: FIXTURE_PODS.find((p) => p.key === target)!.lead, text: GENERIC_REPLY, delay: 1500 }];
    chain.forEach((step) => agentSays(target, step));
  }, [agentSays, say]);

  const rule = useCallback((target: PodKey, ask: FixtureAsk, option: FixtureOption) => {
    setDecided((current) => ({ ...current, [target]: option.id }));
    say(target, { who: 'Sam', faceKey: 'sam', meta: stamp(target), text: option.rule });
    agentSays(target, { faceKey: ask.faceKey, text: option.reply, delay: 1200 });
  }, [agentSays, say]);

  const activePod = useMemo(() => FIXTURE_PODS.find((p) => p.key === pod) as FixturePod, [pod]);
  const ruled = Boolean(decided[pod]);
  const pendingAsk = activePod.ask && !ruled ? activePod.ask : null;

  const stateOf = (agent: FixturePod['agents'][number]): { state: AgentState; title?: string } => (
    ruled && agent.ruledState
      ? { state: agent.ruledState, title: agent.ruledTitle ?? agent.title }
      : { state: agent.state, title: agent.title }
  );
  const statusLine = ({ state, title }: { state: AgentState; title?: string }) => {
    if (state === 'needs-you') return t('inspector.workspace.agentStatus.needsYou', { title });
    if (state === 'working' && title) return t('inspector.workspace.agentStatus.workingTask', { title });
    if (state === 'working') return t('inspector.workspace.agentStatus.working');
    return t('inspector.workspace.agentStatus.idle');
  };
  const workingNames = activePod.agents
    .filter((a) => stateOf(a).state === 'working')
    .map((a) => FACE_NAMES[a.faceKey]);

  const messages = [...activePod.base, ...extra[pod]];
  const chips = activePod.chips.filter((c) => !used[c.id]);
  const todoCount = activePod.board.filter((row) => row.todo && !(ruled && row.ruledState)).length;
  const boardLabel = t('podChat.header.boardTasks', { count: todoCount });
  const members = [...activePod.people, ...activePod.agents.map((a) => a.faceKey)];
  // V2Thread draws three faces and a count, people first.
  const shownFaces = members.slice(0, 3);
  const pods = listView === 'pinned' ? FIXTURE_PODS.filter((p) => p.group === 'pinned') : FIXTURE_PODS;
  const placeholder = t('podChat.composer.placeholder', { podName: activePod.name });

  const selectPod = (key: PodKey) => { setPod(key); setDraft(''); };
  const toggleFold = (key: FoldKey) => setFolds((current) => ({ ...current, [key]: !current[key] }));
  const submitDraft = () => {
    const value = draft;
    setDraft('');
    send(pod, value);
  };

  return (
    <div className="v2-demo">
      <div className="v2-demo__stage">
        {/* rail — decorative chrome, so it stays out of the a11y tree */}
        <div className="v2-demo__rail" {...INERT}>
          <div className="v2-rail">
            <div className="v2-rail__brand">
              <span className="v2-rail__brand-icon">
                <svg width="18" height="18" viewBox="0 0 64 64" fill="none" aria-hidden="true">
                  <path d="M 50 17.7 A 22 22 0 1 0 50 46.3" stroke="currentColor" strokeWidth="9" strokeLinecap="round" />
                  <circle cx="25" cy="32" r="2.4" fill="currentColor" />
                  <circle cx="32" cy="32" r="2.4" fill="currentColor" />
                  <circle cx="39" cy="32" r="2.4" fill="currentColor" />
                </svg>
              </span>
            </div>
            <div className="v2-rail__nav">
              {RAIL_GLYPHS.map((d, index) => (
                <button type="button" key={d} className={`v2-rail__item${index === 0 ? ' v2-rail__item--active' : ''}`}>
                  <span className="v2-rail__item-icon"><RailGlyph d={d} /></span>
                </button>
              ))}
            </div>
            <div className="v2-rail__foot">
              <div className="v2-rail__utility">
                <span className="v2-rail__feedback">
                  <RailGlyph d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2zM12 7v4M12 14h.01" />
                </span>
              </div>
              <V2ThemeSwitch />
              <div className="v2-rail__user">
                <span className="v2-rail__account"><Face faceKey="sam" className="" /></span>
              </div>
            </div>
          </div>
        </div>

        <nav className="v2-demo__pods" aria-label="Sample pods">
          <div className="v2-pods">
            <div className="v2-pods__tools" {...INERT}>
              <span className="v2-pods__search">
                <ShellGlyph name="search" size={15} />
                <span className="v2-demo__search-label">{t('podsSidebar.workspace.search')}</span>
                <kbd className="v2-pods__search-kbd">⌘K</kbd>
              </span>
              <button type="button" className="v2p-b v2p-b-s v2p-ib v2-pods__new">
                <ShellGlyph name="plus" size={16} />
              </button>
            </div>
            <div className="v2-pods__view">
              <V2Segmented<'recent' | 'all' | 'pinned'>
                size="sm"
                ariaLabel={t('podsSidebar.workspace.viewLabel')}
                value={listView}
                onChange={setListView}
                options={[
                  { value: 'recent', label: t('podsSidebar.workspace.recent') },
                  { value: 'all', label: t('podsSidebar.workspace.all'), count: FIXTURE_PODS.length },
                  { value: 'pinned', label: t('podsSidebar.workspace.pinnedTitle') },
                ]}
              />
            </div>
            <div className="v2-pods__list">
              <div className="v2-pods__rows">
                {pods.map((p) => {
                  const needs = Boolean(p.ask && !decided[p.key]);
                  const on = p.key === pod;
                  return (
                    <button
                      type="button"
                      key={p.key}
                      className={`v2-pods__row${on ? ' v2-pods__row--selected' : ''}${needs ? ' v2-pods__row--unread' : ''}`}
                      aria-current={on ? 'true' : undefined}
                      onClick={() => selectPod(p.key)}
                    >
                      <span className="v2-pods__row-mark" aria-hidden="true">{podInitials(p.name)}</span>
                      <span className="v2-pods__row-name">{p.name}</span>
                      <span className="v2-pods__row-meta">
                        {needs && <span className="v2-pods__row-pill">1</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="v2-demo__sample">{t('landing.hero.demoSample')}</div>
          </div>
        </nav>

        <section className="v2-thread v2-demo__thread">
          <header className="v2-thread__header v2-pod-header">
            <div className="v2-thread__header-row">
              <div className="v2-thread__title">
                <div className="v2-thread__title-line"><h3>{activePod.name}</h3></div>
              </div>
              <span className="v2-pod-header__meta">
                <button
                  type="button"
                  className="v2-pod-header__board"
                  aria-expanded={folds.board}
                  title={boardLabel}
                  onClick={() => {
                    setPanelView('pod');
                    toggleFold('board');
                  }}
                >
                  <ShellGlyph name="board" size={13} />
                  <span>{boardLabel}</span>
                </button>
                <span className="v2-pod-header__faces" role="img" aria-label={`${t('podChat.header.members', { count: activePod.people.length })}, ${t('podChat.header.agents', { count: activePod.agents.length })}`}>
                  <span className="v2-pod-header__stack" aria-hidden="true">
                    {shownFaces.map((face) => <Face key={face} faceKey={face} size="sm" className="" />)}
                  </span>
                  {members.length > shownFaces.length && (
                    <span className="v2-pod-header__more" aria-hidden="true">+{members.length - shownFaces.length}</span>
                  )}
                </span>
              </span>
              <span className="v2-demo__invite" {...INERT}>
                <button type="button" className="v2p-b v2p-b-s v2p-b-sm v2-pod-header__invite">
                  <ShellGlyph name="people" size={14} />
                  <span>{t('podChat.header.invite')}</span>
                </button>
              </span>
            </div>
          </header>

          <div className="v2-thread__transcript">
            <div
              className="v2-chat__messages v2-demo__log"
              role="log"
              aria-live="polite"
              aria-label={`Sample thread in ${activePod.name}`}
            >
              <div className="v2-demo__log-inner">
                {messages.map((m, i) => (
                  <div className="v2-msg v2-message-row v2-demo__msg" key={`${m.who}-${m.meta}-${i}`}>
                    <span className="v2-msg__avatar-btn"><Face faceKey={m.faceKey} initial={m.initial} /></span>
                    <div className="v2-msg__body">
                      <div className="v2-msg__head">
                        <span className="v2-msg__author">{m.who}</span>
                        <span className="v2-msg__time">{localTime(m.meta, i18n.language)}</span>
                      </div>
                      <div className="v2-msg__content"><MessageText text={m.text} /></div>
                      {m.sub && <div className="v2-demo__sub">{m.sub}</div>}
                    </div>
                  </div>
                ))}

                {pendingAsk && (
                  // The product's own card markup: the same card an agent's
                  // DecisionRequest renders in the app, with a scripted outcome.
                  // "Other…" is a canned ruling here rather than an input,
                  // because the demo has nothing to send it to.
                  <article className="v2-decision-card" ref={cardRef}>
                    <div className="v2-decision-card__head">
                      <span className="v2-decision-card__agent">{pendingAsk.who}</span>
                      <h3>{pendingAsk.title}</h3>
                    </div>
                    <p className="v2-decision-card__question">{pendingAsk.text}</p>
                    <div className="v2-decision-card__options">
                      {pendingAsk.options.filter((option) => option.id !== 'other').map((option, index) => (
                        <div className="v2-decision-card__option" key={option.id}>
                          <button
                            type="button"
                            className={index === 0
                              ? 'v2-decision-card__choice v2-decision-card__choice--primary'
                              : 'v2-decision-card__choice'}
                            onClick={() => rule(pod, pendingAsk, option)}
                          >
                            {option.label}
                          </button>
                        </div>
                      ))}
                    </div>
                    {pendingAsk.options.filter((option) => option.id === 'other').map((option) => (
                      <div className="v2-decision-card__footer" key={option.id}>
                        <button
                          type="button"
                          className="v2-decision-card__other"
                          onClick={() => rule(pod, pendingAsk, option)}
                        >
                          {option.label}
                        </button>
                      </div>
                    ))}
                  </article>
                )}

                {typing && typing.pod === pod && (
                  <div className="v2-chat__typing" role="status">
                    <span className="v2-chat__typing-dot" aria-hidden="true" />
                    <span className="v2-chat__typing-label">
                      {t('landing.hero.demoWorking', { name: FACE_NAMES[typing.faceKey] })}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {chips.length > 0 && (
            <div className="v2-demo__chips">
              <span className="v2-demo__try">{t('landing.hero.demoTry')}</span>
              {chips.map((chip) => (
                <button
                  type="button"
                  key={chip.id}
                  className="v2p-chip v2p-chip--btn v2-demo__chip"
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
            className={`v2-composer${draft ? ' v2-composer--typing' : ''}`}
            onSubmit={(event) => {
              event.preventDefault();
              submitDraft();
            }}
          >
            <div className="v2-composer__row">
              <div className="v2-composer__plus-wrap" {...INERT}>
                <button type="button" className="v2p-b v2p-b-g v2p-ib v2-composer__plus">
                  <ShellGlyph name="plus" size={18} />
                </button>
              </div>
              <div className="v2-composer__field">
                <label className="v2-demo__sr" htmlFor="v2-demo-draft">Message {activePod.name}</label>
                <textarea
                  id="v2-demo-draft"
                  rows={1}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      submitDraft();
                    }
                  }}
                  placeholder={placeholder}
                  autoComplete="off"
                />
              </div>
              <button
                type="submit"
                className="v2p-b v2p-b-p v2p-ib v2-composer__send"
                aria-label={t('podChat.composer.send')}
              >
                <ShellGlyph name="send" size={16} />
              </button>
            </div>
          </form>
        </section>

        <aside className="v2-demo__inspector" aria-label={t('inspector.workspace.ariaLabel')}>
          <div className="v2-workspace-inspector">
            <div className="v2-workspace-inspector__head">
              <V2Segmented<'pod' | 'threads'>
                size="sm"
                className="v2-workspace-inspector__view"
                ariaLabel={t('inspector.workspace.viewLabel')}
                value={panelView}
                onChange={setPanelView}
                options={[
                  { value: 'pod', label: t('inspector.workspace.viewPod') },
                  { value: 'threads', label: t('inspector.workspace.viewThreads') },
                ]}
              />
              <span className="v2-workspace-inspector__head-spacer" aria-hidden="true" />
              <span className="v2-demo__head-keys" {...INERT}>
                <button type="button" className="v2p-b v2p-b-g v2p-ib v2p-b-sm"><ShellGlyph name="people" /></button>
                <button type="button" className="v2p-b v2p-b-g v2p-ib v2p-b-sm"><ShellGlyph name="gear" /></button>
                <button type="button" className="v2p-b v2p-b-g v2p-ib v2p-b-sm v2-workspace-inspector__hide">
                  <RailGlyph d="M3 5h18v14H3zM15 5v14M17.5 9h1.5M17.5 12h1.5" />
                </button>
              </span>
            </div>

            {panelView === 'threads' ? (
              <div className="v2-workspace-inspector__threads">
                <p className="v2-workspace-inspector__empty">{t('inspector.workspace.noThreads')}</p>
              </div>
            ) : (
              <>
                <Fold id="needs" icon="inbox" label={t('inspector.workspace.needsYou')} count={pendingAsk ? 1 : 0} open={folds.needs} onToggle={toggleFold}>
                  <div className="v2-workspace-inspector__rows v2-demo__needs-rows">
                    {pendingAsk ? (
                      <button
                        type="button"
                        className="v2-workspace-inspector__attention v2-workspace-inspector__attention--item"
                        onClick={() => cardRef.current?.querySelector('button')?.focus()}
                      >
                        <ShellGlyph name="inbox" size={16} />
                        <span className="v2-workspace-inspector__attention-title">{pendingAsk.title}</span>
                        <span className="v2-workspace-inspector__actor">{pendingAsk.who}</span>
                      </button>
                    ) : (
                      <p className="v2-workspace-inspector__empty">
                        {workingNames.length
                          ? t('inspector.workspace.nothingWorking', { agents: workingNames.join(' and '), count: workingNames.length })
                          : t('inspector.workspace.nothingOpen')}
                      </p>
                    )}
                  </div>
                </Fold>

                {folds.board && (
                  <Fold id="board" icon="board" label={boardLabel} open onToggle={toggleFold}>
                    <div className="v2-workspace-inspector__rows">
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
                  </Fold>
                )}

                <Fold
                  id="agents"
                  icon="agents"
                  label={t('inspector.workspace.agents')}
                  count={activePod.agents.length}
                  open={folds.agents}
                  onToggle={toggleFold}
                  trailing={(
                    <span className="v2-workspace-inspector__fold-stack" aria-hidden="true">
                      {activePod.agents.map((agent) => (
                        <Face key={agent.faceKey} faceKey={agent.faceKey} size="sm" className="v2-workspace-inspector__fold-avatar" />
                      ))}
                    </span>
                  )}
                >
                  <div className="v2-workspace-inspector__rows">
                    {activePod.agents.map((agent) => {
                      const state = stateOf(agent);
                      const status = statusLine(state);
                      return (
                        <button type="button" className="v2-workspace-inspector__agent v2-demo__agent" key={agent.faceKey} aria-disabled="true" tabIndex={-1}>
                          <Face faceKey={agent.faceKey} className="v2-workspace-inspector__avatar" />
                          <span className="v2-workspace-inspector__agent-copy">
                            <span className="v2-workspace-inspector__agent-name">{FACE_NAMES[agent.faceKey]}</span>
                            <span className="v2-workspace-inspector__agent-status" title={status}>{status}</span>
                          </span>
                          <span className={`v2-workspace-inspector__state v2-workspace-inspector__state--${state.state}`} aria-hidden="true" />
                        </button>
                      );
                    })}
                  </div>
                </Fold>

                <Fold id="files" icon="file" label={t('inspector.workspace.files')} open={folds.files} onToggle={toggleFold}>
                  <div className="v2-workspace-inspector__rows">
                    <p className="v2-workspace-inspector__empty">{t('inspector.workspace.noFiles')}</p>
                  </div>
                </Fold>

                <Fold id="join" icon="lock" label={t('podsSidebar.create.whoCanJoin')} open={folds.join} onToggle={toggleFold}>
                  <p className="v2-pods__join-policy-hint">{t('podsSidebar.create.privateOption')}</p>
                  {activePod.linked ? (
                    <div className="v2-demo__channel">
                      <span>{activePod.channelName}</span>
                      <span className="v2-demo__channel-count">{activePod.channelCount}</span>
                    </div>
                  ) : (
                    <div className="v2-demo__channel v2-demo__channel--none">+ Connect Slack or Telegram</div>
                  )}
                </Fold>
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
};

export default DemoWorkspace;
