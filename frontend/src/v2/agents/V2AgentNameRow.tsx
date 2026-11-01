import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import V2AgentSettingsIcon from './V2AgentSettingsIcon';
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

// The Identity & access list's Name row. Rename opens the name (and, for
// OpenClaw, persona) form below the row, inside the list.
const V2AgentNameRow: React.FC<Props> = ({ installation, update }) => {
  const { t } = useTranslation();
  const profile = installation.profile;
  const supportsPersona = installation.name.toLowerCase() === 'openclaw';
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState(installation.displayName || '');
  const [persona, setPersona] = useState<PersonaFields>(() => asPersona(profile?.persona));
  const personaChanged = supportsPersona && Object.entries(asPersona(profile?.persona))
    .some(([key, value]) => persona[key as keyof PersonaFields] !== value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDisplayName(installation.displayName || '');
    setPersona(asPersona(profile?.persona));
    setError(null);
    setSaved(false);
  }, [installation, profile]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = displayName.trim();
    if (!name || name.length > 80) {
      setError('agentSettings.identityNameError');
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await update({
        ...(name !== installation.displayName ? { displayName: name } : {}),
        ...(personaChanged ? { persona: {
          tone: persona.tone,
          specialties: commaList(persona.specialties),
          boundaries: commaList(persona.boundaries),
          customInstructions: persona.customInstructions,
        } } : {}),
      });
      setSaved(true);
    } catch (requestError) {
      const response = (requestError as { response?: { status?: number; data?: { code?: string } } })?.response;
      const status = response?.status;
      const messageKey: Record<number, string> = {
        400: 'agentSettings.identityNameError',
        403: 'agentSettings.identityPermissionError',
        409: 'agentSettings.identityScopeError',
        503: 'agentSettings.identityMirrorError',
      };
      const code = response?.data?.code;
      setError(code === 'agent_display_name_taken'
        ? 'agentSettings.identityNameTakenError'
        : code === 'identity_projection_retryable'
          ? 'agentSettings.identityProjectionError'
          : messageKey[status || 0] || 'agentSettings.identitySaveError');
    } finally {
      setBusy(false);
    }
  };

  // Errors are stored as keys so the name refusals can sit under the field and the rest beside Save.
  const nameError = error === 'agentSettings.identityNameError' || error === 'agentSettings.identityNameTakenError';
  const alertRow = (text: string) => <span role="alert" className="v2-agent-settings-page__note">
    <V2AgentSettingsIcon name="alert" />{text}
  </span>;
  const specialtyCount = commaList(persona.specialties).length;
  const boundaryCount = commaList(persona.boundaries).length;
  const formId = `agent-identity-form-${installation.instanceId}`;
  return <>
    <div className="lrow">
      <span className="lb"><V2AgentSettingsIcon name="user" />{t('agentSettings.name')}</span>
      <span className="vl">{installation.displayName || installation.instanceId}</span>
      <span className="ac">
        <button type="button" className="b b-g ib b-sm" title={t('agentSettings.rename')} aria-label={t('agentSettings.rename')}
          aria-expanded={open} aria-controls={formId} onClick={() => setOpen((value) => !value)}>
          <V2AgentSettingsIcon name="pencil" />
        </button>
      </span>
    </div>
    {open && <div id={formId} className="v2-agent-settings-page__panel">
      <form className="v2-agent-settings-page__form" onSubmit={save} noValidate>
        <div className="lrow v2-agent-settings-page__stack">
          <label className="lb" htmlFor="agent-identity-name"><V2AgentSettingsIcon name="user" />{t('agentSettings.displayName')}</label>
          <span className="vl">
            <span className="field v2-agent-settings-page__name">
              <input id="agent-identity-name" value={displayName} maxLength={80} required
                aria-invalid={nameError || undefined} aria-describedby={nameError ? 'agent-identity-name-error' : undefined}
                onChange={(event) => setDisplayName(event.target.value)} />
              <span className="mu" aria-hidden="true">{displayName.length} / 80</span>
            </span>
            {nameError && error && <span id="agent-identity-name-error" role="alert" className="v2-agent-settings-page__fielderror">{t(error)}</span>}
          </span>
          <span className="ac" />
        </div>
        {supportsPersona && <details className="disc">
          <summary>
            <span className="lb" id="agent-identity-persona"><V2AgentSettingsIcon name="smile" />{t('agentSettings.persona')}</span>
            <span className="vl">{t(`agentSettings.toneOptions.${persona.tone}`, { defaultValue: persona.tone })}
              {(specialtyCount > 0 || boundaryCount > 0) && <span className="mo">
                {[specialtyCount > 0 && t('agentSettings.specialtyCount', { count: specialtyCount }),
                  boundaryCount > 0 && t('agentSettings.boundaryCount', { count: boundaryCount })].filter(Boolean).join(' · ')}
              </span>}
            </span>
            <V2AgentSettingsIcon name="chev" className="chev" />
          </summary>
          <fieldset className="dbody" aria-labelledby="agent-identity-persona">
            <label className="v2-agent-settings-page__pair"><span className="mu">{t('agentSettings.tone')}</span>
              <span className="field">
                <select value={persona.tone} onChange={(event) => setPersona({ ...persona, tone: event.target.value })}>
                  {['friendly', 'professional', 'casual', 'formal', 'technical'].map((tone) => (
                    <option key={tone} value={tone}>{t(`agentSettings.toneOptions.${tone}`)}</option>
                  ))}
                </select>
                <V2AgentSettingsIcon name="chev" />
              </span>
            </label>
            <label className="v2-agent-settings-page__pair"><span className="mu">{t('agentSettings.specialties')}</span>
              <span className="field">
                <input value={persona.specialties} onChange={(event) => setPersona({ ...persona, specialties: event.target.value })} />
              </span>
            </label>
            <label className="v2-agent-settings-page__pair"><span className="mu">{t('agentSettings.boundaries')}</span>
              <span className="field">
                <input value={persona.boundaries} onChange={(event) => setPersona({ ...persona, boundaries: event.target.value })} />
              </span>
            </label>
            <label className="v2-agent-settings-page__pair v2-agent-settings-page__pair--top"><span className="mu">{t('agentSettings.personaNotes')}</span>
              <span className="field field--area">
                <textarea value={persona.customInstructions} rows={3} onChange={(event) => setPersona({ ...persona, customInstructions: event.target.value })} />
              </span>
            </label>
          </fieldset>
        </details>}
        <div className="lrow v2-agent-settings-page__stack">
          <span className="lb" />
          <span className="vl">
            <button type="submit" className="b b-p b-sm" disabled={busy || (!personaChanged && displayName.trim() === installation.displayName)}>{busy ? t('agentSettings.saving') : t('agentSettings.saveIdentity')}</button>
            {saved && <span role="status" className="v2-agent-settings-page__note"><V2AgentSettingsIcon name="check" />{t('agentSettings.identitySaved')}</span>}
            {error && !nameError && alertRow(t(error))}
          </span>
          <span className="ac" />
        </div>
      </form>
    </div>}
  </>;
};

export default V2AgentNameRow;
