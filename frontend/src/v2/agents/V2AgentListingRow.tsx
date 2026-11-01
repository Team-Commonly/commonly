import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import axios from '../../utils/axiosConfig';
import { useAuth } from '../../context/AuthContext';
import V2AgentSettingsIcon from './V2AgentSettingsIcon';
import { useOpensOnDemand } from '../hooks/useOpensOnDemand';

interface Props {
  agentName: string;
  instanceId: string;
}

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

// The Identity & access list's Listing row: the registry status and the public
// profile link. Registry owner controls (TASK-419 part 2) sit behind a toggle
// that only the listing's publisher sees; the server re-checks ownership on every PATCH.
const V2AgentListingRow: React.FC<Props> = ({ agentName, instanceId }) => {
  const { t } = useTranslation();
  const { currentUser } = useAuth();
  const [listingStatus, setListingStatus] = useState('listingLoading');
  const [listing, setListing] = useState<ListingData | null>(null);
  const [listingName, setListingName] = useState('');
  const [listingBusy, setListingBusy] = useState(false);
  const [listingError, setListingError] = useState<string | null>(null);
  // A failed save opens the panel where its message is.
  const [open, setOpen] = useOpensOnDemand(Boolean(listingError));

  useEffect(() => {
    let active = true;
    setListingStatus('listingLoading');
    void axios.get<ListingData>(`/api/registry/agents/${encodeURIComponent(agentName)}`)
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
  }, [agentName]);

  const entryOwnerId = listing?.publisher?.userId ? String(listing.publisher.userId) : null;
  const ownsListing = Boolean(currentUser?._id) && entryOwnerId === String(currentUser._id);
  const retired = listing?.status === 'unpublished';
  const saveListing = async (patch: { displayName?: string; retired?: boolean }) => {
    setListingBusy(true);
    setListingError(null);
    try {
      const { data } = await axios.patch<ListingData>(`/api/registry/agents/${encodeURIComponent(agentName)}/owned-entry`, patch);
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
  const panelId = `agent-listing-owner-${instanceId}`;
  const panelOpen = ownsListing && open;
  return <>
    <div className="lrow">
      <span className="lb"><V2AgentSettingsIcon name="store" />{t('agentSettings.listingTitle')}</span>
      <span className="vl"><span role="status">{t(`agentSettings.${listingStatus}`)}</span>
        {ownsListing && <span className="mo">{t('agentSettings.ownedTitle')}</span>}
      </span>
      <span className="ac">
        {/* On a phone the label folds away and the link is an icon button, so the status keeps the row. */}
        <Link className="b b-g b-sm v2-agent-settings-page__textbtn" to={`/v2/agent/${encodeURIComponent(agentName)}/${encodeURIComponent(instanceId)}`}
          aria-label={t('agentSettings.viewPublicProfile')} title={t('agentSettings.viewPublicProfile')}>
          <span className="v2-agent-settings-page__textbtn-label">{t('agentSettings.viewPublicProfile')}</span><V2AgentSettingsIcon name="out" />
        </Link>
        {ownsListing && <button type="button" className="b b-g ib b-sm" title={t('agentSettings.manageListing')}
          aria-label={t('agentSettings.manageListing')} aria-expanded={panelOpen} aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}>
          <V2AgentSettingsIcon name="more" />
        </button>}
      </span>
    </div>
    {panelOpen && <div id={panelId} className="v2-agent-settings-page__panel v2-agent-settings-page__panel--pad">
      <label className="v2-agent-settings-page__pair"><span className="mu">{t('agentSettings.ownedName')}</span>
        <span className="field">
          <input value={listingName} maxLength={80} disabled={listingBusy} onChange={(event) => setListingName(event.target.value)} />
        </span>
      </label>
      <div className="v2-agent-settings-page__actions">
        <button type="button" className="b b-s b-sm" disabled={listingBusy || !listingName.trim()} onClick={() => saveListing({ displayName: listingName.trim() })}>
          {t('agentSettings.ownedSave')}
        </button>
        <button type="button" className="b b-g b-sm" disabled={listingBusy} onClick={() => saveListing({ retired: !retired })}>
          {retired ? t('agentSettings.ownedRestore') : t('agentSettings.ownedRetire')}
        </button>
      </div>
      {listingError && <span role="alert" className="v2-agent-settings-page__note">
        <V2AgentSettingsIcon name="alert" />{listingError}
      </span>}
    </div>}
  </>;
};

export default V2AgentListingRow;
