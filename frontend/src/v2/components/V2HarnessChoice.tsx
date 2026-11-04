import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  HarnessCatalogEntry, HarnessDeviceRow, OTHER_MODEL, effortLevelsFor, harnessLabel, modelChoicesFor,
} from '../utils/harnessCatalog';

// D247: model and effort on the add-agent page, from the same catalogue
// Settings uses. The value saved is the full model id. With no harness picked
// (auto-detect) only the model's default shows, as before.
const V2HarnessChoice: React.FC<{
  catalog: HarnessCatalogEntry[];
  harness: string;
  device?: HarnessDeviceRow | null;
  model: string;
  effort: string;
  onModel: (value: string) => void;
  onEffort: (value: string) => void;
}> = ({ catalog, harness, device = null, model, effort, onModel, onEffort }) => {
  const { t } = useTranslation();
  const [other, setOther] = useState(false);
  const entry = catalog.find((row) => row.id === harness) || null;
  const choices = harness ? modelChoicesFor(entry, device) : null;
  const levels = harness ? effortLevelsFor(entry, device) : [];
  const tool = harnessLabel(catalog, harness);
  return (
    <>
      <label className="v2-byo__field">
        <span className="v2-byo__label">{t('agentByo.form.modelLabel')}</span>
        {choices && !other ? (
          <select
            value={model}
            onChange={(e) => {
              if (e.target.value === OTHER_MODEL) { setOther(true); onModel(''); return; }
              onModel(e.target.value);
            }}
            className="v2-byo__input"
            data-testid="byo-model-select"
          >
            <option value="">{t('agentByo.form.modelDefault')}</option>
            {choices.models.map((id) => <option key={id} value={id}>{id}</option>)}
            <option value={OTHER_MODEL}>{t('harness.other')}</option>
          </select>
        ) : harness ? (
          <input
            type="text"
            value={model}
            onChange={(e) => { onModel(e.target.value); }}
            placeholder={other ? t('harness.otherPlaceholder') : t('agentByo.form.modelDefault')}
            className="v2-byo__input"
            data-testid="byo-model-select"
          />
        ) : (
          <select value="" disabled className="v2-byo__input" data-testid="byo-model-select">
            <option value="">{t('agentByo.form.modelDefault')}</option>
          </select>
        )}
        <span className="v2-byo__hint">
          {!harness ? t('agentByo.form.modelHintAuto')
            : choices && !other ? t('agentByo.form.modelHintList', { tool })
              : t('agentByo.form.modelHintFree', { tool })}
        </span>
      </label>
      {levels.length > 0 && (
        <label className="v2-byo__field">
          <span className="v2-byo__label">{t('agentByo.form.effortLabel')}</span>
          <select
            value={effort}
            onChange={(e) => { onEffort(e.target.value); }}
            className="v2-byo__input"
            data-testid="byo-effort-select"
          >
            <option value="">{t('agentByo.form.modelDefault')}</option>
            {levels.map((level) => <option key={level} value={level}>{level}</option>)}
          </select>
        </label>
      )}
    </>
  );
};

export default V2HarnessChoice;
