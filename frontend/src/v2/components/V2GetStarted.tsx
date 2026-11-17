import React from 'react';
import { useTranslation } from 'react-i18next';
import { ShellGlyph } from '../icons/glyphs';
import { trackUsage } from '../utils/usageEvents';
import type { V2StarterSteps } from '../hooks/useV2PodHeaderMeta';
import type { WelcomePick } from '../utils/welcomePick';

// The first-run bar, as the first-run artboard draws it. It puts the two
// starter tasks sign-up seeds on screen in place of the "3 to do" chip. Only
// the current step acts; a done step is struck through, a later one waits.
// The invite step stays on the board (Sam's call), and the bar leaves once
// both steps are done.

type Step = 'connect' | 'first-task';

interface Props {
  steps: V2StarterSteps;
  podId: string;
  onConnect: () => void;
  onFirstTask: () => void;
  /** The bar takes the board chip's place, so it carries the way to the board. */
  onOpenBoard: () => void;
  /** F516: the person's own agent that was made but never connected; step 1 names it. */
  pendingAgentName?: string;
  /**
   * How the person chose to get their first agent (utils/welcomePick.ts), so
   * step 1 names the same first step as Scout's filled key. With no pick and
   * hosting offered, step 1 is the two equal choices Scout offers.
   */
  pick?: WelcomePick;
  /** Starts a hosted agent the way Scout's "Run an agent here" does; absent where hosting isn't offered. */
  onRunHosted?: () => void;
  hostedStarting?: boolean;
}

const V2GetStarted: React.FC<Props> = ({
  steps, podId, onConnect, onFirstTask, onOpenBoard, pendingAgentName, pick = null, onRunHosted, hostedStarting = false,
}) => {
  const { t } = useTranslation();
  if (steps.connect && steps.firstTask) return null;
  const current: Step = steps.connect ? 'first-task' : 'connect';
  const done = Number(steps.connect) + Number(steps.firstTask);
  // Once the hosted agent is live its offer goes away, but the done step still
  // names what the person did.
  const hostedFirst = pick === 'hosted' && (Boolean(onRunHosted) || steps.connect);
  // No pick yet and hosting offered: step 1 is a choice, as on Scout's welcome.
  const choosing = !steps.connect && pick === null && Boolean(onRunHosted);
  const track = (step: string) => trackUsage('get-started-click', { props: { step }, podId });
  const rows: Array<{ step: Step; label: string; isDone: boolean; act: () => void; busy?: boolean }> = [
    {
      step: 'connect',
      label: hostedFirst
        ? (hostedStarting ? t('agentByo.actions.starting') : t('podChat.starts.labels.run-hosted'))
        : (pendingAgentName ? t('podChat.getStarted.finishConnecting', { name: pendingAgentName }) : t('podChat.getStarted.connect')),
      isDone: steps.connect,
      act: hostedFirst && onRunHosted ? onRunHosted : onConnect,
      // The hosted start in flight: the key says so and takes no second press.
      busy: hostedFirst && hostedStarting && !steps.connect,
    },
    { step: 'first-task', label: t('podChat.getStarted.firstTask'), isDone: steps.firstTask, act: onFirstTask },
  ];
  return (
    <div className="v2-get-started" role="group" aria-label={t('podChat.getStarted.title')} data-testid="get-started">
      <span className="v2-get-started__title">{t('podChat.getStarted.title')}</span>
      {rows.map(({ step, label, isDone, act, busy }, index) => {
        const now = step === current;
        if (step === 'connect' && choosing && onRunHosted) {
          return (
            <span key={step} className="v2-get-started__choice" role="group" aria-label={t('podChat.getStarted.choose')} data-testid="get-started-choice">
              <span className="v2-get-started__n" aria-hidden="true">1</span>
              <button
                type="button"
                className="v2-get-started__step v2-get-started__step--now"
                aria-current="step"
                aria-busy={hostedStarting || undefined}
                disabled={hostedStarting}
                data-testid="get-started-run-hosted"
                onClick={() => { track('run-hosted'); onRunHosted(); }}
              >
                {hostedStarting ? t('agentByo.actions.starting') : t('podChat.starts.labels.run-hosted')}
              </button>
              <span className="v2-get-started__or" aria-hidden="true">{t('podChat.getStarted.or')}</span>
              <button
                type="button"
                className="v2-get-started__step v2-get-started__step--now"
                aria-current="step"
                data-testid="get-started-connect"
                onClick={() => { track('connect'); onConnect(); }}
              >
                {t('podChat.getStarted.connectOwn')}
              </button>
            </span>
          );
        }
        return (
          <button
            key={step}
            type="button"
            className={`v2-get-started__step${now ? ' v2-get-started__step--now' : ''}${isDone ? ' v2-get-started__step--done' : ''}`}
            aria-disabled={now ? undefined : true}
            aria-current={now ? 'step' : undefined}
            aria-busy={busy || undefined}
            disabled={busy}
            aria-label={isDone ? t('podChat.getStarted.done', { step: label }) : undefined}
            data-testid={`get-started-${step}`}
            onClick={() => {
              if (!now || busy) return;
              track(step === 'connect' && hostedFirst ? 'run-hosted' : step);
              act();
            }}
          >
            <span className="v2-get-started__n" aria-hidden="true">
              {isDone ? <ShellGlyph name="check" size={13} /> : index + 1}
            </span>
            {label}
            {now && <ShellGlyph name="chevron-right" size={14} />}
          </button>
        );
      })}
      <span className="v2-get-started__sp" />
      <span className="v2-get-started__count">{t('podChat.getStarted.count', { done, total: 2 })}</span>
      <button type="button" className="v2-get-started__board" onClick={onOpenBoard} data-testid="get-started-board">
        <ShellGlyph name="board" size={13} />
        {t('podChat.getStarted.board')}
      </button>
    </div>
  );
};

export default V2GetStarted;
