import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import axios from '../../utils/axiosConfig';
import { useAuth } from '../../context/AuthContext';
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

interface ListingData {
  status?: string; registry?: string; ephemeral?: boolean; verified?: boolean;
  displayName?: string; publisher?: { userId?: string };
}

// One mapper for the GET and for the PATCH answer, so the status line can't drift from the entry.
const listingStatusKey = (data: ListingData): string => {
  if (data.ephemeral || data.registry === 'private' || data.status === 'unpublished') return 'listingNotPublished';
  if (data.status === 'pending-review') return 'listingInReview';
  if (data.status === 'deprecated') return 'listingDeprecated';
  if (data.status === 'active') return data.verified ? 'listingPublished' : 'listingNotInCatalog';
  return 'listingNotPublished';
};

const V2AgentIdentitySection: React.FC<Props> = ({ installation, update }) => {
  const { t } = useTranslation();
  const profile = installation.profile;
  const supportsPersona = installation.name.toLowerCase() === 'openclaw';
  const [displayName, setDisplayName] = useState(installation.displayName || '');
  const [persona, setPersona] = useState<PersonaFields>(() => asPersona(profile?.persona));
  const personaChanged = supportsPersona && Object.entries(asPersona(profile?.persona))
    .some(([key, value]) => persona[key as keyof PersonaFields] !== value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [listingStatus, setListingStatus] = useState('listingLoading');
  // Registry owner controls (TASK-419 part 2). The GET names the publisher;
  // the server re-checks ownership on every PATCH.
  const { currentUser } = useAuth();
  const [listing, setListing] = useState<ListingData | null>(null);
  const [listingName, setListingName] = useState('');
  const [listingBusy, setListingBusy] = useState(false);
  const [listingError, setListingError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setListingStatus('listingLoading');
    void axios.get<ListingData>(`/api/registry/agents/${encodeURIComponent(installation.name)}`)
      .then(({ data }) => {
        if (!active) return;
        setListing(data);
        setListingName(data.displayName || '');
        setListingStatus(listingStatusKey(data));
      }).catch((requestError) => {
        if (!active) return;
        const status = (requestError as { response?: { status?: number } })?.response?.status;
        setListingStatus(status === 404 ? 'listingNotPublished' : 'listingUnavailable');
      });
    return () => { active = false; };
  }, [installation.name]);

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
      setError(t('agentSettings.identityNameError'));
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
      setError(t(code === 'agent_display_name_taken'
        ? 'agentSettings.identityNameTakenError'
        : code === 'identity_projection_retryable'
          ? 'agentSettings.identityProjectionError'
          : messageKey[status || 0] || 'agentSettings.identitySaveError'));
    } finally {
      setBusy(false);
    }
  };

  const entryOwnerId = listing?.publisher?.userId ? String(listing.publisher.userId) : null;
  const ownsListing = Boolean(currentUser?._id) && entryOwnerId === String(currentUser._id);
  const retired = listing?.status === 'unpublished';
  const saveListing = async (patch: { displayName?: string; retired?: boolean }) => {
    setListingBusy(true);
    setListingError(null);
    try {
      const { data } = await axios.patch<ListingData>(`/api/registry/agents/${encodeURIComponent(installation.name)}/owned-entry`, patch);
      // The PATCH answer carries the new status; verified and registry are not in it, so keep the GET's.
      const next = { ...listing, ...data };
      setListing(next);
      setListingName(next.displayName || '');
      setListingStatus(listingStatusKey(next));
    } catch {
      setListingError(t('agentSettings.ownedFailed'));
    } finally {
      setListingBusy(false);
    }
  };
  return <section className="v2-agent-settings__section" aria-labelledby="agent-identity-title">
    <h2 id="agent-identity-title">{t('agentSettings.identityTitle')}</h2>
    <form className="v2-agent-settings__identity" onSubmit={save}>
      <label><span>{t('agentSettings.displayName')}</span>
        <input value={displayName} maxLength={80} required onChange={(event) => setDisplayName(event.target.value)} />
      </label>
      {supportsPersona && <fieldset><legend>{t('agentSettings.persona')}</legend>
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
      </fieldset>}
      <div className="v2-agent-settings__actions">
        <button type="submit" disabled={busy || (!personaChanged && displayName.trim() === installation.displayName)}>{busy ? t('agentSettings.saving') : t('agentSettings.saveIdentity')}</button>
        {saved && <span role="status">{t('agentSettings.identitySaved')}</span>}
      </div>
      {error && <p role="alert" className="v2-agent-settings__error">{error}</p>}
    </form>
    <div className="v2-agent-settings__listing">
      <h3>{t('agentSettings.listingTitle')}</h3>
      <p role="status">{t(`agentSettings.${listingStatus}`)}</p>
      <Link to={`/v2/agent/${encodeURIComponent(installation.name)}/${encodeURIComponent(installation.instanceId)}`}>
        {t('agentSettings.viewPublicProfile')}
      </Link>
      <p>{t('agentSettings.listingSeparate')}</p>
      {ownsListing && <div className="v2-agent-settings__owned">
        <h3>{t('agentSettings.ownedTitle')}</h3>
        <label><span>{t('agentSettings.ownedName')}</span>
          <input value={listingName} maxLength={80} disabled={listingBusy} onChange={(event) => setListingName(event.target.value)} />
        </label>
        <button type="button" disabled={listingBusy || !listingName.trim()} onClick={() => saveListing({ displayName: listingName.trim() })}>
          {t('agentSettings.ownedSave')}
        </button>
        <button type="button" disabled={listingBusy} onClick={() => saveListing({ retired: !retired })}>
          {retired ? t('agentSettings.ownedRestore') : t('agentSettings.ownedRetire')}
        </button>
        {listingError && <p role="alert" className="v2-agent-settings__error">{listingError}</p>}
      </div>}
    </div>
  </section>;
};

export default V2AgentIdentitySection;
