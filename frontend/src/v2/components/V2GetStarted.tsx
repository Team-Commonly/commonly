import React from 'react';
import { useTranslation } from 'react-i18next';
import { ShellGlyph } from '../icons/glyphs';
import { trackUsage } from '../utils/usageEvents';
import type { V2StarterSteps } from '../hooks/useV2PodHeaderMeta';

// D288: the first-run bar, as the first-run artboard draws it. It puts the two
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
}

const V2GetStarted: React.FC<Props> = ({ steps, podId, onConnect, onFirstTask, onOpenBoard }) => {
  const { t } = useTranslation();
  if (steps.connect && steps.firstTask) return null;
  const current: Step = steps.connect ? 'first-task' : 'connect';
  const done = Number(steps.connect) + Number(steps.firstTask);
  const rows: Array<{ step: Step; label: string; isDone: boolean; act: () => void }> = [
    { step: 'connect', label: t('podChat.getStarted.connect'), isDone: steps.connect, act: onConnect },
    { step: 'first-task', label: t('podChat.getStarted.firstTask'), isDone: steps.firstTask, act: onFirstTask },
  ];
  return (
    <div className="v2-get-started" role="group" aria-label={t('podChat.getStarted.title')} data-testid="get-started">
      <span className="v2-get-started__title">{t('podChat.getStarted.title')}</span>
      {rows.map(({ step, label, isDone, act }, index) => {
        const now = step === current;
        return (
          <button
            key={step}
            type="button"
            className={`v2-get-started__step${now ? ' v2-get-started__step--now' : ''}${isDone ? ' v2-get-started__step--done' : ''}`}
            aria-disabled={now ? undefined : true}
            aria-current={now ? 'step' : undefined}
            aria-label={isDone ? t('podChat.getStarted.done', { step: label }) : undefined}
            data-testid={`get-started-${step}`}
            onClick={() => {
              if (!now) return;
              trackUsage('get-started-click', { props: { step }, podId });
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
