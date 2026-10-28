import React from 'react';
import { useTranslation } from 'react-i18next';
import { HARNESS_WALK_TABLE, HarnessOsState, HarnessWalkRow } from '../utils/harnessWalkTable';

interface V2HarnessPickerProps {
  selectedId: string;
  onSelect: (id: string) => void;
}

const GLYPH_PROPS = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true };

const ClipboardGlyph = () => (
  <svg {...GLYPH_PROPS}><rect x="6" y="4" width="12" height="17" rx="2" /><path d="M9 4V3h6v1" /></svg>
);
const TerminalGlyph = () => (
  <svg {...GLYPH_PROPS}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9l3 3-3 3M13 15h4" /></svg>
);
const LockGlyph = () => (
  <svg {...GLYPH_PROPS}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
);

// One dot per OS. Filled when walked, dashed ring otherwise. The title says why.
const OsDot = ({ state, os, row }: { state: HarnessOsState; os: 'mac' | 'linux' | 'windows'; row: HarnessWalkRow }) => {
  const { t } = useTranslation();
  const title = t(`agentByo.harnessPicker.osState.${state}`, { os: t(`agentByo.harnessPicker.${os}`) });
  return (
    <span
      className={`v2-harness-picker__dot v2-harness-picker__dot--${state}`}
      data-testid={`harness-dot-${row.id}-${os}`}
      data-state={state}
      title={title}
      aria-label={title}
      role="img"
    />
  );
};

const HarnessRow = ({ row, selected, onSelect }: { row: HarnessWalkRow; selected: boolean; onSelect: (id: string) => void }) => {
  const { t } = useTranslation();
  const connectsLabel = t(row.connects === 'command' ? 'agentByo.harnessPicker.connectsCommand' : 'agentByo.harnessPicker.connectsTerminal');
  return (
    <button
      type="button"
      className={`v2-harness-picker__row${selected ? ' v2-harness-picker__row--selected' : ''}`}
      aria-pressed={selected}
      data-testid={`harness-row-${row.id}`}
      onClick={() => onSelect(row.id)}
    >
      <span className="v2-harness-picker__name">
        <span className="v2-harness-picker__mark" aria-hidden="true">{row.monogram}</span>
        <span>{row.label}</span>
        {row.privatePodsOnly && (
          <span className="v2-harness-picker__lock" role="img" title={t('agentByo.harnessPicker.privateOnly')} aria-label={t('agentByo.harnessPicker.privateOnly')}>
            <LockGlyph />
          </span>
        )}
      </span>
      <span className="v2-harness-picker__connects" role="img" title={connectsLabel} aria-label={connectsLabel} data-testid={`harness-connects-${row.id}`}>
        {row.connects === 'command' ? <ClipboardGlyph /> : <TerminalGlyph />}
      </span>
      <OsDot state={row.os.mac} os="mac" row={row} />
      <OsDot state={row.os.linux} os="linux" row={row} />
      <OsDot state={row.os.windows} os="windows" row={row} />
    </button>
  );
};

// Renders only the rows in HARNESS_WALK_TABLE. Hidden harnesses have no entry to render.
const V2HarnessPicker = ({ selectedId, onSelect }: V2HarnessPickerProps) => {
  const { t } = useTranslation();
  return (
    <div className="v2-harness-picker" role="group" aria-label={t('agentByo.harnessPicker.label')} data-testid="harness-picker">
      <div className="v2-harness-picker__head" aria-hidden="true">
        <span />
        <span>{t('agentByo.harnessPicker.connects')}</span>
        <span>{t('agentByo.harnessPicker.mac')}</span>
        <span>{t('agentByo.harnessPicker.linux')}</span>
        <span>{t('agentByo.harnessPicker.windows')}</span>
      </div>
      {HARNESS_WALK_TABLE.map((row) => (
        <HarnessRow key={row.id} row={row} selected={row.id === selectedId} onSelect={onSelect} />
      ))}
    </div>
  );
};

export default V2HarnessPicker;
