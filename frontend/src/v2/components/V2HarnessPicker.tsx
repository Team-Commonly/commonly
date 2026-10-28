import React from 'react';
import { useTranslation } from 'react-i18next';
import { HARNESS_WALK_TABLE, HarnessOsState, HarnessWalkRow } from '../utils/harnessWalkTable';

interface V2HarnessPickerProps {
  selectedId: string;
  onSelect: (id: string) => void;
}

// One dot per OS: filled when walked, dashed ring when not. A row never hides an OS.
const OsDot = ({ state, os }: { state: HarnessOsState; os: string }) => (
  <span
    className={`v2-harness-picker__dot v2-harness-picker__dot--${state}`}
    data-testid={`harness-dot-${os}`}
    data-state={state}
    aria-hidden="true"
  />
);

const HarnessRow = ({ row, selected, onSelect }: { row: HarnessWalkRow; selected: boolean; onSelect: (id: string) => void }) => {
  const { t } = useTranslation();
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
        {row.label}
        {row.privatePodsOnly && (
          <span className="v2-harness-picker__lock" title={t('agentByo.harnessPicker.privateOnly')}>
            {t('agentByo.harnessPicker.privateOnly')}
          </span>
        )}
      </span>
      <span className="v2-harness-picker__connects" data-testid={`harness-connects-${row.id}`}>
        {row.connects === 'command' ? t('agentByo.harnessPicker.connectsCommand') : t('agentByo.harnessPicker.connectsTerminal')}
      </span>
      <OsDot os="mac" state={row.os.mac} />
      <OsDot os="linux" state={row.os.linux} />
      <OsDot os="windows" state={row.os.windows} />
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
