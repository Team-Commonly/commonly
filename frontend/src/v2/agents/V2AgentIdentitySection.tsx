import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentSettingsInstallation, AgentSettingsPatch } from './useAgentSettings';

interface Props {
  installation: AgentSettingsInstallation;
  update: (patch: AgentSettingsPatch) => Promise<unknown>;
}

interface PersonaFields {
  tone: string;
  specialties: string;
  boundaries: string;
  customInstructions: string;
}

const commaList = (value: string): string[] => value.split(',').map((part) => part.trim()).filter(Boolean);

const asPersona = (value: unknown): PersonaFields => {
  const persona = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    tone: typeof persona.tone === 'string' ? persona.tone : 'friendly',
    specialties: Array.isArray(persona.specialties) ? persona.specialties.join(', ') : '',
    boundaries: Array.isArray(persona.boundaries) ? persona.boundaries.join(', ') : '',
    customInstructions: typeof persona.customInstructions === 'string' ? persona.customInstructions : '',
  };
};

const V2AgentIdentitySection: React.FC<Props> = ({ installation, update }) => {
  const { t } = useTranslation();
  const profile = installation.profile;
  const [displayName, setDisplayName] = useState(installation.displayName || '');
  const [instructions, setInstructions] = useState(profile?.instructions || '');
  const [persona, setPersona] = useState<PersonaFields>(() => asPersona(profile?.persona));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDisplayName(installation.displayName || '');
    setInstructions(profile?.instructions || '');
    setPersona(asPersona(profile?.persona));
    setError(null);
    setSaved(false);
  }, [installation, profile]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = displayName.trim();
    if (!name || name.length > 80) {
      setError(t('agentSettings.identityNameError'));
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await update({
        ...(name !== installation.displayName ? { displayName: name } : {}),
        instructions,
        persona: {
          tone: persona.tone,
          specialties: commaList(persona.specialties),
          boundaries: commaList(persona.boundaries),
          customInstructions: persona.customInstructions,
        },
      });
      setSaved(true);
    } catch (requestError) {
      const apiError = (requestError as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(apiError || t('agentSettings.identitySaveError'));
    } finally {
      setBusy(false);
    }
  };

  return <section className="v2-agent-settings__section" aria-labelledby="agent-identity-title">
    <h2 id="agent-identity-title">{t('agentSettings.identityTitle')}</h2>
    <form className="v2-agent-settings__identity" onSubmit={save}>
      <label><span>{t('agentSettings.displayName')}</span>
        <input value={displayName} maxLength={80} required onChange={(event) => setDisplayName(event.target.value)} />
      </label>
      <label><span>{t('agentSettings.instructions')}</span>
        <textarea value={instructions} rows={5} onChange={(event) => setInstructions(event.target.value)} />
      </label>
      <fieldset><legend>{t('agentSettings.persona')}</legend>
        <label><span>{t('agentSettings.tone')}</span>
          <select value={persona.tone} onChange={(event) => setPersona({ ...persona, tone: event.target.value })}>
            {['friendly', 'professional', 'casual', 'formal', 'technical'].map((tone) => (
              <option key={tone} value={tone}>{t(`agentSettings.toneOptions.${tone}`)}</option>
            ))}
          </select>
        </label>
        <label><span>{t('agentSettings.specialties')}</span>
          <input value={persona.specialties} onChange={(event) => setPersona({ ...persona, specialties: event.target.value })} />
        </label>
        <label><span>{t('agentSettings.boundaries')}</span>
          <input value={persona.boundaries} onChange={(event) => setPersona({ ...persona, boundaries: event.target.value })} />
        </label>
        <label><span>{t('agentSettings.personaNotes')}</span>
          <textarea value={persona.customInstructions} rows={3} onChange={(event) => setPersona({ ...persona, customInstructions: event.target.value })} />
        </label>
      </fieldset>
      <div className="v2-agent-settings__actions">
        <button type="submit" disabled={busy}>{busy ? t('agentSettings.saving') : t('agentSettings.saveIdentity')}</button>
        {saved && <span role="status">{t('agentSettings.identitySaved')}</span>}
      </div>
      {error && <p role="alert" className="v2-agent-settings__error">{error}</p>}
    </form>
  </section>;
};

export default V2AgentIdentitySection;
