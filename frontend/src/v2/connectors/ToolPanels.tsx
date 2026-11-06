// The Tools panels: a grant's details and trail, the Add and Change access form,
// the GitHub App setup, and the connection notices. Moved from the old Tools list
// (TASK-733); verbs and copy are unchanged. The rows that opened them are gone.
import React from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { localizeRelativeTime, localizeWindow } from '../utils/localizeRelativeTime';
import { ActGlyph } from '../icons/glyphs';
import { PlatformGlyph } from '../icons/platforms';
import { catalogDescription } from '../utils/connectorCatalogDescription';
import {
  shortAge,
  isExpired,
  isDead,
  boundAgentOf,
  entryOffersPrWrite,
  PER_ENTRY_REVOKE_COPY,
} from './toolModel';
import type {
  ByoCandidate,
  ByoSandbox,
  GrantWriteMode,
  ToolGrant,
  ToolOutcome,
  ToolCatalogEntry,
  HiddenToolConnection,
  ToolConnection,
  PodSeat,
} from './toolModel';
import type { ToolConnectorsModel } from './useToolConnectors';
import OperatorKeyForm from './OperatorKeyForm';

const G: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{children}</svg>
);
/** Outcome marks: a category, so a glyph; the word stays in the log line and the title.
 *
 * The `superseded` mark is a shield with a SHORT BAR, not the shield-and-check it
 * first shipped with: the resolution it stands for may be an
 * approval, a decline or an expiry, and the row beside it carries the verdict —
 * a check read as "approved" next to a sibling that says `refused`. The bar says
 * settled without saying how. */
const OutcomeGlyph: React.FC<{ outcome: ToolOutcome }> = ({ outcome }) => {
  if (outcome === 'ok') return <G><path d="M20 6 9 17l-5-5" /></G>;
  if (outcome === 'refused') return <G><path d="M18 6 6 18M6 6l12 12" /></G>;
  if (outcome === 'pending_approval') return <G><path d="M12 3 4 6v6c0 5 3.4 8.4 8 9 4.6-.6 8-4 8-9V6z" /><path d="M12 8v5M12 16h.01" /></G>;
  if (outcome === 'superseded') return <G><path d="M12 3 4 6v6c0 5 3.4 8.4 8 9 4.6-.6 8-4 8-9V6z" /><path d="M9 12h6" /></G>;
  return <G><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></G>;
};
/** Mode marks: eye for read, pen for write, shield for write that asks first. */
const ModeGlyph: React.FC<{ mode: GrantWriteMode }> = ({ mode }) => {
  if (mode === 'read') return <G><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></G>;
  if (mode === 'write') return <G><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></G>;
  return <G><path d="M12 3 4 6v6c0 5 3.4 8.4 8 9 4.6-.6 8-4 8-9V6z" /><path d="m9 12 2 2 4-4" /></G>;
};


export const useToolPanels = (m: ToolConnectorsModel) => {
  const { t, i18n } = useTranslation();
  const {
    manualRevokeNotice,
    isGranter,
    seats,
    trail,
    trailError,
    selectedId,
    setSelectedId,
    draft,
    setDraft,
    githubAppSetup,
    setGithubAppSetup,
    staleAfterChange,
    confirmRevoke,
    setConfirmRevoke,
    confirmDisconnect,
    setConfirmDisconnect,
    confirmHiddenRemoval,
    setConfirmHiddenRemoval,
    busy,
    error,
    joinPolicyFixPodId,
    policyFixedPodId,
    grants,
    now,
    isAdmin,
    podIds,
    entryFor,
    noticeMatchesEntry,
    toolLabel,
    podName,
    memberName,
    seatLabel,
    grantPodId,
    joinList,
    audienceLabels,
    irreversibleTools,
    asksFirst,
    outcomeLabel,
    reasonLabel,
    modeLabel,
    grantModeLabel,
    entryGrantModes,
    entryModeCopy,
    usedRecently,
    openDraft,
    openGithubAppSetup,
    draftEntry,
    draftTools,
    draftPrWrite,
    draftBoundAgent,
    startingAudience,
    selectedAgentIds,
    draftByoCandidates,
    draftByoNamed,
    draftByoKey,
    draftByoConsented,
    removeByoAgent,
    submitDraft,
    fixJoinPolicy,
    connectHostedMcp,
    keyAgents,
    keyAgentsUnavailable,
    submitOperatorKey,
    submitGithubAppSetup,
    retryStaleRevoke,
    revoke,
    removeHiddenConnection,
    disconnect,
  } = m;
  const renderManualRevokeNotice = (entry: ToolCatalogEntry | null) => {
    if (!manualRevokeNotice || !noticeMatchesEntry(entry)) return null;
    // Per-entry copy names only what that vendor's page lists; entries without it fall back to the generic line.
    const context = PER_ENTRY_REVOKE_COPY.has(manualRevokeNotice.entryId) ? manualRevokeNotice.entryId : undefined;
    return (
      <p className="v2-connector-row__refusal" role="status">
        {t('connectors.hostedMcpManualRevoke', {
          defaultValue: 'Your previous {{provider}} account may still have Commonly connected. Switch to it on {{provider}}, then remove Commonly there.',
          context,
          provider: manualRevokeNotice.provider,
        })}{' '}
        <a href={manualRevokeNotice.revokePage} target="_blank" rel="noopener noreferrer">
          {t('connectors.hostedMcpReviewAuthorization', {
            defaultValue: "Open {{provider}}'s connected apps",
            context,
            provider: manualRevokeNotice.provider,
          })}
        </a>
      </p>
    );
  };
  const agentNameById = (agentId?: string): string => {
    if (!agentId) return '';
    const seat = Object.values(seats).flat().find((candidate) => candidate.userId === agentId);
    return seat?.displayName || seat?.name || '';
  };
  // Names one hosted connection: a key row by its agent, the sign-in as such,
  // and both by when. Null when the server did not describe the row (no
  // connectedAt), so it cannot be told apart.
  const connectionLabel = (connection: ToolConnection): string | null => {
    if (!connection.connectedAt || Number.isNaN(Date.parse(connection.connectedAt))) return null;
    const date = new Date(connection.connectedAt).toLocaleDateString(i18n.language, { month: 'short', day: 'numeric' });
    const separator = t('tools.connectionSeparator', { defaultValue: ' · ' });
    if (connection.agentId) {
      return [t('tools.connectionKey', { defaultValue: 'Key' }), agentNameById(connection.agentId), date].filter(Boolean).join(separator);
    }
    return [t('tools.connectionSignedIn', { defaultValue: 'Signed in' }), date].join(separator);
  };
  // Hosted connections only: a GitHub App connection is the instance's, not the viewer's to drop.
  const renderDisconnect = (entry: ToolCatalogEntry | null, variant: 'row' | 'aside') => {
    const hosted = entry && entry.connectionType === 'hosted-mcp' ? entry.connections : [];
    if (!entry || hosted.length === 0) return null;
    // A lone key row still names its agent, so the person can see whose key it is.
    if (hosted.length === 1 && !(hosted[0].agentId && connectionLabel(hosted[0]))) {
      const button = renderDisconnectOne(entry, hosted[0], variant, null);
      return variant === 'aside' ? <div className="v2-connector-aside__actions">{button}</div> : button;
    }
    // Several connections: each is named, so each gets its own Disconnect. A
    // connection that cannot be told apart (the server did not describe it, or
    // it reads the same as another) gets none rather than one that might drop
    // the wrong connection.
    const labelled = hosted.map((connection) => ({ connection, label: connectionLabel(connection) }));
    const labels = labelled.map((row) => row.label);
    if (labels.some((label) => !label) || new Set(labels).size < labels.length) return null;
    return (
      <>
        {labelled.map(({ connection, label }) => (variant === 'aside' ? (
          <div key={connection.connectionId} className="v2-connector-aside__actions">
            <span className="v2-connector-aside__conn">{label}</span>
            {renderDisconnectOne(entry, connection, variant, label)}
          </div>
        ) : (
          <span key={connection.connectionId} className="v2-cx-pop__acts">
            <span className="v2-cx-note">{label}</span>
            {renderDisconnectOne(entry, connection, variant, label)}
          </span>
        )))}
      </>
    );
  };
  const renderDisconnectOne = (entry: ToolCatalogEntry, connection: ToolConnection, variant: 'row' | 'aside', label: string | null) => {
    const cls = variant === 'row'
      ? 'v2-connector-row__action v2-connector-row__action--secondary'
      : 'v2-connector-aside__secondary';
    if (confirmDisconnect === connection.connectionId) {
      return (
        <>
          <button type="button" className={variant === 'row' ? 'v2-connector-row__action' : 'v2-connector-aside__primary'} disabled={busy} onClick={() => { void disconnect(entry, connection.connectionId); }}>
            {t('tools.confirmDisconnect', { defaultValue: 'Yes, disconnect' })}
          </button>
          <button type="button" className={cls} disabled={busy} onClick={() => setConfirmDisconnect(null)}>
            {t('tools.keep', { defaultValue: 'Keep it' })}
          </button>
        </>
      );
    }
    return (
      <button
        type="button"
        className={cls}
        aria-label={label
          ? t('tools.disconnectConnectionLabel', { defaultValue: 'Disconnect {{label}}: {{connection}}', label: entry.label, connection: label })
          : t('tools.disconnectLabel', { defaultValue: 'Disconnect {{label}}', label: entry.label })}
        onClick={() => setConfirmDisconnect(connection.connectionId)}
      >
        {t('tools.disconnect', { defaultValue: 'Disconnect' })}
      </button>
    );
  };

  const renderHiddenConnection = (connection: HiddenToolConnection) => (
    <article key={connection.connectionId} className="v2-connector-row">
      <span className="v2-connector-row__name">
        <span className="v2-connector-row__dot v2-connector-row__dot--empty" aria-hidden="true" />
        <span>{connection.label}</span>
      </span>
      <span className="v2-connector-row__details">
        <span className="v2-connector-row__kicker">{t('tools.existingConnection', { defaultValue: 'existing connection' })}</span>
        <strong>{t('tools.noLongerOffered', { defaultValue: 'This connector is no longer offered here.' })}</strong>
        {connection.revokePage && <a href={connection.revokePage} target="_blank" rel="noopener noreferrer">{t('tools.reviewProviderAccess', { defaultValue: 'Review access at {{label}}', label: connection.label })}</a>}
      </span>
      {confirmHiddenRemoval === connection.connectionId ? (
        <>
          <button type="button" className="v2-connector-row__action" disabled={busy} onClick={() => { void removeHiddenConnection(connection); }}>
            {t('tools.confirmRemoveConnection', { defaultValue: 'Yes, remove' })}
          </button>
          <button type="button" className="v2-connector-row__action v2-connector-row__action--secondary" onClick={() => setConfirmHiddenRemoval(null)}>
            {t('tools.keep', { defaultValue: 'Keep' })}
          </button>
        </>
      ) : (
        <button type="button" className="v2-connector-row__action v2-connector-row__action--secondary" onClick={() => setConfirmHiddenRemoval(connection.connectionId)}>
          {t('tools.removeConnection', { defaultValue: 'Remove connection' })}
        </button>
      )}
    </article>
  );

  const renderRow = (grant: ToolGrant) => {
    const dead = isDead(grant, now);
    const podId = grantPodId(grant);
    const granter = memberName(grant.grantedBy);
    const isSelected = selectedId === grant.grantId;
    const entry = entryFor(grant);
    const label = toolLabel(grant);
    // A grant the catalogue no longer covers keeps the server-named connector's glyph (TASK-753).
    const glyph = entry?.installableId || grant.connector?.id;
    const noticeGrantId = noticeMatchesEntry(entry)
      ? (grants || []).find((candidate) => (
        !isDead(candidate, now) && entryFor(candidate)?.installableId === entry?.installableId
      ))?.grantId
      : null;
    // What the grant was given TO, which is a seat when the target is a seat. It
    // is not the row's location: the kicker and the accessible name both name the
    // pod the row lives in, so a seat grant under Ops has a sentence reading
    // `granted to Reed` in a row announced as `View GitHub in Ops`. Sharing one
    // label between the two put the seat's name where the location belongs
    // (TASK-179, ux-lead's gate at 07873c19) — two nouns, so two expressions.
    const targetLabel = grant.target.kind === 'pod' ? podName(grant.target.id) : seatLabel(podId, grant.target.id);
    // Direction A rule 3: `pod · verb age` — the verb from a key, the age from the timestamp.
    const when = t('tools.grantedAge', { defaultValue: 'granted {{age}}', age: shortAge(grant.createdAt, now, t) });
    const kicker = `${podId ? podName(podId) : seatLabel(null, grant.target.id)} · ${when}`;
    const revokedBy = grant.revokedBy ? memberName(grant.revokedBy) : null;
    const line2 = dead
      ? (grant.revokedAt
        ? (revokedBy
          ? t('tools.revokedByLine', { defaultValue: 'revoked by {{member}} {{rel}}', member: revokedBy, rel: localizeRelativeTime(grant.revokedAt, t, { now, pastEvent: true }) })
          : t('tools.revokedLine', { defaultValue: 'revoked {{rel}}', rel: localizeRelativeTime(grant.revokedAt, t, { now, pastEvent: true }) }))
        : t('tools.expiredLine', { defaultValue: 'expired {{rel}}', rel: localizeRelativeTime(grant.expiresAt, t, { now }) }))
      // Direction A rule 1: the write mode is the glyph beside this line; its words ride the 390 kicker.
      // One interpolated key, not `{{agents}}` + a separate 'may use it': a language
      // that orders the clause differently needs the whole sentence (TASK-164). The
      // rendered English is unchanged.
      // An empty audience is its own sentence, not the interpolated one with an empty
      // subject: zh writes 「没有智能体可以使用」 with no space, which `{{agents}} 可以使用`
      // cannot produce (TASK-179).
      : (grant.effectiveAudience.length === 0
        ? t('tools.nobodyMayUse', { defaultValue: 'nobody may use it' })
        : t('tools.mayUse', { defaultValue: '{{agents}} may use it', agents: audienceLabels(grant) }));
    return (
      <article key={grant.grantId} className={`v2-connector-row${isSelected ? ' v2-connector-row--selected' : ''}${dead ? ' v2-connector-row--dead' : ''}`}>
        <button
          type="button"
          className="v2-connector-row__selection"
          aria-pressed={isSelected}
          aria-label={t('tools.viewGrant', { defaultValue: 'View {{tool}} in {{pod}}', tool: label, pod: podId ? podName(podId) : seatLabel(null, grant.target.id) })}
          onClick={() => { setSelectedId(isSelected ? null : grant.grantId); setDraft(null); setConfirmRevoke(null); }}
        >
          <span className="v2-connector-row__name">
            <span className={`v2-connector-row__dot ${dead ? 'v2-connector-row__dot--empty' : `v2-connector-row__dot--live${usedRecently(grant) ? ' v2-connector-row__dot--pulse' : ''}`}`} aria-hidden="true" />
            <span className="v2-connector-row__glyph" aria-hidden="true">
              {glyph && <PlatformGlyph type={glyph} />}
            </span>
            <span>{label}</span>
          </span>
          <span className="v2-connector-row__details">
            <span className="v2-connector-row__kicker">
              {kicker}
              {!dead && <span className="v2-connector-row__kicker-mode"> · {asksFirst(grant)}</span>}
              {(entry ? entry.entryId : grant.connector?.id) === 'atlassian' && <span> · {t('tools.readInTesting', { defaultValue: 'read in testing' })}</span>}
            </span>
            <strong>
              {/* Direction A: what the tool does is the not-yet row's and the aside's sentence, not the granted row's. */}
              {/* One key per sentence, both names ordered by the language. The old shape
                  composed three pieces (`granted to` + pod + `by` + member), so zh could
                  only read 「授权给 Growth 授权者 sam」 (TASK-179). */}
              {granter ? (
                <Trans i18nKey="tools.grantedToPodBy" values={{ pod: targetLabel, member: granter }} components={{ b: <b /> }} />
              ) : (
                <Trans i18nKey="tools.grantedToPod" values={{ pod: targetLabel }} components={{ b: <b /> }} />
              )}
            </strong>
            <span className="v2-connector-row__detail">
              {!dead && <span className="v2-tools__mode" title={grantModeLabel(grant)} role="img" aria-label={grantModeLabel(grant)}><ModeGlyph mode={grant.writeMode} /></span>}
              {line2}
            </span>
          </span>
        </button>
        {dead && entry && isGranter(grant) ? (
          // Grant again is the granter's too: the mint 403s anyone but the Connection's owner.
          <button type="button" className="v2-connector-row__action v2-connector-row__action--secondary" onClick={() => openDraft(entry, grant)}>
            {t('tools.grantAgain', { defaultValue: 'Grant again' })}
          </button>
        ) : (
          // Direction A rule 2: Manage is housekeeping beside the row's word, so it is the gear.
          <button
            type="button"
            className="v2-connector-row__action v2-connector-row__action--secondary v2-connector-row__action--icon"
            title={t('tools.manage', { defaultValue: 'Manage' })}
            aria-label={t('tools.manage', { defaultValue: 'Manage' })}
            onClick={() => { setSelectedId(grant.grantId); setDraft(null); setConfirmRevoke(null); }}
          >
            <ActGlyph name="manage" />
          </button>
        )}
        {noticeGrantId === grant.grantId && renderManualRevokeNotice(entry)}
      </article>
    );
  };

  // Where the person who connected a hosted entry picks what it reaches (for
  // GitHub, the App's install page). Shown on the offer and on the details of
  // their live grant, since a grant takes the entry off the offer list.
  // For an operator-key entry the same page is where the key is made, and the
  // key's scopes are what bound its reach.
  const renderAccessLink = (entry: ToolCatalogEntry) => (
    <a href={entry.accessPage} target="_blank" rel="noopener noreferrer">
      {entry.credentialMode === 'operator_key'
        ? t('tools.operatorKey.createKey', { label: entry.label })
        : t('tools.chooseAccess', { defaultValue: 'Choose what {{label}} can reach', label: entry.label })}
    </a>
  );

  // An operator-key entry holds one connection per agent (TASK-330), so it
  // stays open to a key for each of the person's agents that has none yet. An
  // OAuth entry is connected once, by `connections.length`.
  const keylessAgents = (entry: ToolCatalogEntry) => {
    const keyed = new Set(entry.connections.map((connection) => connection.agentId).filter(Boolean));
    return keyAgents.filter((agent) => !keyed.has(agent.userId));
  };

  // The paste-a-key form while any of the person's agents has no key on this
  // operator-key entry. It is offered on a granted entry too: one agent's key
  // being granted says nothing about the next agent's.
  const renderKeyForm = (entry: ToolCatalogEntry) => {
    const takesKey = entry.connectionType === 'hosted-mcp' && Boolean(entry.entryId) && entry.credentialMode === 'operator_key';
    const keyable = takesKey && entry.available ? keylessAgents(entry) : [];
    return keyable.length > 0
      ? <OperatorKeyForm key={entry.installableId} entry={entry} agents={keyable} submit={submitOperatorKey} />
      : null;
  };

  // Where to make the key, for a granted entry's drawer, which skips the
  // ungranted offer and its renderEntryNote. Ungranted, renderEntryNote
  // carries the same two lines.
  const renderKeyGuidance = (entry: ToolCatalogEntry) => (
    <>
      {entry.connectNotice && <p className="v2-cx-note">{entry.connectNotice}</p>}
      {entry.accessPage && <p className="v2-cx-note">{renderAccessLink(entry)}</p>}
    </>
  );

  // What a person can do with an entry that has no live grant: the verbs of the
  // old "Not yet" row, shared by the tile's popover.
  const renderEntryActions = (entry: ToolCatalogEntry) => {
    const canAdd = entry.available && entry.connections.length > 0 && podIds.length > 0;
    const canInstallGithubApp = isAdmin && entry.installableId === 'github' && entry.available && entry.connections.length === 0;
    // A hosted entry is connected by the person who will grant it (§1: member
    // mode), so the action belongs on the tile and needs no admin.
    const isHosted = entry.connectionType === 'hosted-mcp' && Boolean(entry.entryId);
    const takesKey = isHosted && entry.credentialMode === 'operator_key';
    const canConnectHosted = isHosted && !takesKey && entry.available && entry.connections.length === 0;
    return (
      <>
        {renderKeyForm(entry)}
        {!entry.available && (
          <a className="v2-connector-row__action v2-connector-row__action--secondary" href="https://github.com/Team-Commonly/commonly/issues/new?title=Connector%20request">
            {t('tools.ask', { defaultValue: 'Ask' })}
          </a>
        )}
        {canConnectHosted && (
          <button type="button" className="v2-connector-row__action" onClick={() => { void connectHostedMcp(entry); }}>
            {t('tools.connect', { defaultValue: 'Connect' })}
          </button>
        )}
        {canAdd && (
          <button type="button" className="v2-connector-row__action" onClick={() => openDraft(entry)}>
            {t('tools.add', { defaultValue: 'Add' })}
          </button>
        )}
        {renderDisconnect(entry, 'row')}
        {canInstallGithubApp && (
          <button type="button" className="v2-connector-row__action" onClick={openGithubAppSetup}>
            {t('tools.installGitHubApp', { defaultValue: 'Install GitHub App' })}
          </button>
        )}
      </>
    );
  };

  // F213: the form offers Linear no write, so the line says that. When write
  // mode returns, a connection made before write access needs reconnecting: the
  // server refuses it the mode, and the page cannot see a connection's scope.
  const renderLinearWriteNote = (entry: ToolCatalogEntry) => (
    entry.connectionType === 'hosted-mcp' && entry.entryId === 'linear' && entry.connections.length > 0
      ? <p className="v2-cx-note" role="note">{t('tools.linearWriteReconnect')}</p>
      : null
  );

  // TASK-782: a connection whose account saw nothing to search at connect.
  // A warning, never a block: the person may add a project afterwards.
  const renderReachNote = (entry: ToolCatalogEntry, connections: ToolConnection[]) => (
    connections.some((connection) => connection.reach === 'none')
      ? <p className="v2-cx-note" role="note">{t('tools.reachNone', { label: entry.label })}</p>
      : null
  );

  // The one line under an entry's name that says what is left to do before it
  // works: connect your own account, ask an admin, or the modes it grants.
  const renderEntryNote = (entry: ToolCatalogEntry) => {
    const isHosted = entry.connectionType === 'hosted-mcp' && Boolean(entry.entryId);
    const takesKey = isHosted && entry.credentialMode === 'operator_key';
    const canConnectHosted = isHosted && !takesKey && entry.available && entry.connections.length === 0;
    const keyable = takesKey && entry.available ? keylessAgents(entry) : [];
    const unconnectedNote = () => {
      if (takesKey) {
        if (keyAgents.length === 0 && keyAgentsUnavailable) return t('tools.operatorKey.agentsUnavailable');
        return keyAgents.length === 0
          ? t('tools.operatorKey.noAgents')
          : t('tools.operatorKey.note');
      }
      return isHosted
        ? t('tools.connectOwn', { defaultValue: 'connect your own {{label}} account', label: entry.label })
        : t('tools.noConnection', { defaultValue: 'install the GitHub App first · an admin does this once' });
    };
    return (
      <>
        {entry.available && (
          <p className="v2-cx-note">
            {entry.connections.length === 0 ? unconnectedNote() : entryModeCopy(entry)}
          </p>
        )}
        {renderLinearWriteNote(entry)}
        {renderReachNote(entry, entry.connections)}
        {(canConnectHosted || keyable.length > 0) && entry.connectNotice && <p className="v2-cx-note">{entry.connectNotice}</p>}
        {isHosted && entry.available && entry.accessPage && <p className="v2-cx-note">{renderAccessLink(entry)}</p>}
        {renderManualRevokeNotice(entry)}
      </>
    );
  };

  const renderGithubAppSetup = () => {
    if (!githubAppSetup) return null;
    return (
      <aside className="v2-connectors__aside v2-tools__aside" aria-label={t('tools.installGitHubApp', { defaultValue: 'Install GitHub App' })}>
        <section className="v2-connector-aside__card">
          <p className="v2-connector-aside__eyebrow">{t('tools.adminSetup', { defaultValue: 'administrator setup' })}</p>
          <h2>{t('tools.installGitHubApp', { defaultValue: 'Install GitHub App' })}</h2>
          <p>{t('tools.githubAppSetupHint', { defaultValue: 'Connect the GitHub App once so people can grant GitHub tools to their pods.' })}</p>
          <div className="v2-tools__form">
            <label className="v2-tools__field">
              <span>{t('tools.installationId', { defaultValue: 'installation ID' })}</span>
              <input
                className="v2-tools__input"
                value={githubAppSetup.installationId}
                onChange={(event) => setGithubAppSetup({ ...githubAppSetup, installationId: event.target.value })}
                aria-label={t('tools.installationId', { defaultValue: 'installation ID' })}
              />
            </label>
            <label className="v2-tools__field">
              <span>{t('tools.owner', { defaultValue: 'owner' })}</span>
              <input
                className="v2-tools__input"
                value={githubAppSetup.owner}
                onChange={(event) => setGithubAppSetup({ ...githubAppSetup, owner: event.target.value })}
                aria-label={t('tools.owner', { defaultValue: 'owner' })}
              />
            </label>
            <label className="v2-tools__field">
              <span>{t('tools.repository', { defaultValue: 'repository' })}</span>
              <input
                className="v2-tools__input"
                value={githubAppSetup.repo}
                onChange={(event) => setGithubAppSetup({ ...githubAppSetup, repo: event.target.value })}
                aria-label={t('tools.repository', { defaultValue: 'repository' })}
              />
            </label>
          </div>
          <div className="v2-connector-aside__actions">
            <button
              type="button"
              className="v2-connector-aside__primary"
              disabled={busy || !githubAppSetup.installationId.trim() || !githubAppSetup.owner.trim() || !githubAppSetup.repo.trim()}
              onClick={() => { void submitGithubAppSetup(); }}
            >
              {busy ? t('tools.installingGitHubApp', { defaultValue: 'Installing…' }) : t('tools.installGitHubApp', { defaultValue: 'Install GitHub App' })}
            </button>
            <button type="button" className="v2-connector-aside__secondary" disabled={busy} onClick={() => setGithubAppSetup(null)}>
              {t('tools.cancel', { defaultValue: 'Cancel' })}
            </button>
          </div>
          {error && <p className="v2-connector-aside__note" role="alert">{error}</p>}
        </section>
      </aside>
    );
  };

  // F94: the disclosure for one agent that runs outside Commonly. The server
  // records 'confined' only on evidence, so anything else reads as no sandbox.
  const byoAgentLabel = (agent: ByoCandidate) => agentNameById(agent.userId) || agent.agentName;
  const byoConsentLine = (agent: ByoCandidate) => (agent.sandbox !== 'confined'
    ? t('tools.byo.consentNoSandbox', { agent: byoAgentLabel(agent) })
    : t('tools.byo.consent', { agent: byoAgentLabel(agent) }));
  const byoReason = (agent: ByoCandidate) => (agent.reason === 'unconfined_host'
    ? t('tools.byo.reasonUnconfinedHost')
    : t('tools.byo.reasonAdapterUnsupported'));
  const byoNamedLine = (name: string, sandbox: ByoSandbox | undefined) => (sandbox !== 'confined'
    ? t('tools.byo.namedNoSandbox', { agent: name })
    : t('tools.byo.named', { agent: name }));

  const renderDraft = () => {
    if (!draft || !draftEntry) return null;
    const podSeats = seats[draft.podId] || [];
    // A key connection offers only its own agent: the route refuses any other.
    // The viewer's agents that run outside Commonly join the roster when it hid them.
    const byoOnly: PodSeat[] = draftByoCandidates
      .filter((agent) => !podSeats.some((seat) => seat.userId === agent.userId))
      .map((agent) => ({ userId: agent.userId, name: agent.agentName, instanceId: agent.instanceId }));
    const allSeats = [...podSeats, ...byoOnly];
    const offeredSeats = draftBoundAgent ? allSeats.filter((seat) => seat.userId === draftBoundAgent) : allSeats;
    const naming = draftByoNamed.length > 0;
    const boundAbsent = Boolean(draftBoundAgent) && offeredSeats.length === 0;
    const boundName = draftBoundAgent ? (agentNameById(draftBoundAgent) || memberName(draftBoundAgent)) : null;
    // A key grant whose key was removed opens with no key chosen (openDraft):
    // the picker shows even for one remaining key, and the seats wait for a key.
    const keyPending = draftEntry.credentialMode === 'operator_key' && !draft.connectionId;
    const tools = draftTools(draftEntry, draft.writeMode, draftPrWrite, draft.prTools);
    const irreversible = irreversibleTools(draftEntry, tools);
    const asks = draftPrWrite
      ? t('tools.asksPrWrite', { defaultValue: 'every commit, push and pull request asks you first' })
      : draft.writeMode === 'read' ? t('tools.asksNothing', { defaultValue: 'nothing asks first' })
      : draft.writeMode === 'write-with-confirm'
        ? t('tools.asksEveryWrite', { defaultValue: 'a write would ask first' })
        : (irreversible.length ? t('tools.asksList', { defaultValue: '{{tools}} ask first', tools: joinList(irreversible) }) : t('tools.asksNothing', { defaultValue: 'nothing asks first' }));
    return (
      <aside className="v2-connectors__aside v2-tools__aside" aria-label={draft.replaces ? t('tools.changeAccess', { defaultValue: 'Change access' }) : t('tools.addTool', { defaultValue: 'Add {{tool}}', tool: draftEntry.label })}>
        <section className="v2-connector-aside__card">
          <p className="v2-connector-aside__eyebrow">{draft.replaces ? t('tools.changeAccess', { defaultValue: 'Change access' }) : t('tools.grant', { defaultValue: 'grant' })}</p>
          <h2>{draftEntry.label} · {podName(draft.podId)}</h2>
          <p>{catalogDescription(i18n, draftEntry.installableId, draftEntry.description)}</p>
          <div className="v2-tools__form">
            {!draft.replaces && podIds.length > 1 && (
              <label className="v2-tools__field">
                <span>{t('tools.toRoom', { defaultValue: 'pod' })}</span>
                <select className="v2-connectors__select" value={draft.podId} onChange={(event) => { const podId = event.target.value; setDraft({ ...draft, podId, audience: startingAudience(draftEntry, draft.connectionId, podId) }); }}>
                  {podIds.map((podId) => <option key={podId} value={podId}>{podName(podId)}</option>)}
                </select>
              </label>
            )}
            {(draftEntry.connections.length > 1 || (keyPending && draftEntry.connections.length > 0)) && (
              <label className="v2-tools__field">
                <span>{t('tools.connection', { defaultValue: 'connection' })}</span>
                <select
                  className="v2-connectors__select"
                  value={draft.connectionId}
                  onChange={(event) => {
                    const connectionId = event.target.value;
                    // A key connection's audience follows its agent; any other keeps the picked seats.
                    setDraft(boundAgentOf(draftEntry, connectionId)
                      ? { ...draft, connectionId, audience: startingAudience(draftEntry, connectionId, draft.podId) }
                      : { ...draft, connectionId });
                  }}
                >
                  {keyPending && (
                    <option value="" disabled>{t('tools.chooseKey', { defaultValue: 'Choose a key' })}</option>
                  )}
                  {draftEntry.connections.map((connection) => {
                    // A key connection has no owner or repo, so it is named by its agent.
                    const keyAgent = boundAgentOf(draftEntry, connection.connectionId);
                    return (
                      <option key={connection.connectionId} value={connection.connectionId}>
                        {keyAgent
                          ? (agentNameById(keyAgent) || memberName(keyAgent) || t('tools.connectionKey', { defaultValue: 'Key' }))
                          : <>{connection.owner}/{connection.repo}</>}
                      </option>
                    );
                  })}
                </select>
              </label>
            )}
            {renderReachNote(draftEntry, draftEntry.connections.filter((connection) => connection.connectionId === draft.connectionId))}
            <div className="v2-tools__field">
              <span>{t('tools.mode', { defaultValue: 'what it may do' })}</span>
              <div className="v2-connector-aside__mode" role="group" aria-label={t('tools.mode', { defaultValue: 'what it may do' })}>
                {entryGrantModes(draftEntry).map((mode) => (
                  <button key={mode} type="button" aria-pressed={draft.writeMode === mode} disabled={(naming || draftPrWrite) && mode !== 'read'} className={draft.writeMode === mode ? 'v2-connector-aside__mode-opt v2-connector-aside__mode-opt--on' : 'v2-connector-aside__mode-opt'} onClick={() => setDraft({ ...draft, writeMode: mode })}>
                    {modeLabel(mode)}
                  </button>
                ))}
              </div>
              {naming && !draftPrWrite && entryGrantModes(draftEntry).length > 1 && <span className="v2-tools__hint">{t('tools.byo.readOnlyHint')}</span>}
              {entryOffersPrWrite(draftEntry) && (
                <label className="v2-connector-aside__relay">
                  <input type="checkbox" checked={draft.prWrite} onChange={(event) => setDraft({ ...draft, prWrite: event.target.checked, writeMode: event.target.checked ? 'read' : draft.writeMode })} />
                  <span>{t('tools.prWriteChoice', { defaultValue: 'Agents can also open pull requests from their own branch. You approve each commit, push and pull request.' })}</span>
                </label>
              )}
              {draft.losesPrWrite && !draftPrWrite && (
                <span className="v2-tools__hint" role="status">{t('tools.prWriteEnds', { defaultValue: 'This change ends pull-request access on this grant.' })}</span>
              )}
              <span className="v2-tools__hint">{tools.length ? tools.map((tool) => <code key={tool}>{tool}</code>) : t('tools.noTools', { defaultValue: 'no tools on the allow-list' })}</span>
              <span className="v2-tools__hint">{asks}</span>
            </div>
            {!keyPending && (
            <fieldset className="v2-tools__field v2-tools__agents">
              <legend>{t('tools.agents', { defaultValue: 'agents' })}</legend>
              {!draftBoundAgent && allSeats.length === 0 && <span className="v2-tools__hint">{t('tools.noSeats', { defaultValue: 'no agent in this pod yet' })}</span>}
              {boundAbsent && (
                <span className="v2-tools__hint" role="status">
                  {boundName
                    ? t('tools.keyAgentNotInPod', { defaultValue: "{{agent}} isn't in this pod.", agent: boundName })
                    : t('tools.keyAgentNotInPodUnnamed', { defaultValue: "This key's agent isn't in this pod." })}
                </span>
              )}
              {offeredSeats.map((seat) => {
                if (!seat.userId) return null;
                const byo = draftByoCandidates.find((agent) => agent.userId === seat.userId);
                const unnameable = Boolean(byo && !byo.nameable);
                return (
                  <React.Fragment key={seat.userId}>
                    <label className="v2-connector-aside__relay">
                      <input type="checkbox" disabled={unnameable} checked={!unnameable && draft.audience.includes(seat.userId)} onChange={(event) => setDraft({ ...draft, audience: event.target.checked ? [...draft.audience, seat.userId as string] : draft.audience.filter((id) => id !== seat.userId) })} />
                      {seat.displayName || seat.name}
                    </label>
                    {byo && unnameable && <span className="v2-tools__hint">{byoReason(byo)}</span>}
                  </React.Fragment>
                );
              })}
              {draftBoundAgent && !boundAbsent && (
                <span className="v2-tools__hint">{t('tools.keyOnlyAgent', { defaultValue: 'Only {{agent}} can use this key.', agent: boundName || t('tools.aSeat', { defaultValue: 'an agent' }) })}</span>
              )}
            </fieldset>
            )}
            {selectedAgentIds.length === 0 && !boundAbsent && !keyPending && (
              <p className="v2-connector-aside__note" role="status">{t('tools.emptyAudienceNotice', {
                defaultValue: 'Select at least one agent to grant access.',
              })}</p>
            )}
            <label className="v2-tools__field">
              <span>{t('tools.ends', { defaultValue: 'ends' })}</span>
              <select className="v2-connectors__select" value={draft.expiryDays} onChange={(event) => setDraft({ ...draft, expiryDays: Number(event.target.value) as 7 | 30 | 90 })}>
                <option value={7}>{t('tools.days', { defaultValue: 'in {{count}} days', count: 7 })}</option>
                <option value={30}>{t('tools.days', { defaultValue: 'in {{count}} days', count: 30 })}</option>
                <option value={90}>{t('tools.days', { defaultValue: 'in {{count}} days', count: 90 })}</option>
              </select>
            </label>
            {/* F94: one consent for the agents this grant names, each with its sandbox state. */}
            {naming && (
              <label className="v2-connector-aside__relay">
                <input type="checkbox" checked={draftByoConsented} onChange={(event) => setDraft({ ...draft, byoConsentFor: event.target.checked ? draftByoKey : null })} />
                <span>{[...draftByoNamed.map((agent) => byoConsentLine(agent)), ...(draftPrWrite ? [t('tools.byo.prWriteConsent', { agents: joinList(draftByoNamed.map(byoAgentLabel)) })] : [])].join(t('tools.sentenceSeparator', { defaultValue: ' ' }))}</span>
              </label>
            )}
          </div>
          <div className="v2-connector-aside__actions">
            <button type="button" className="v2-connector-aside__primary" disabled={busy || !draft.connectionId || !draft.podId || selectedAgentIds.length === 0 || tools.length === 0 || (naming && !draftByoConsented)} onClick={() => { void submitDraft(); }}>
              {busy ? t('tools.granting', { defaultValue: 'Granting…' }) : t('tools.grantAct', { defaultValue: 'Grant' })}
            </button>
            <button type="button" className="v2-connector-aside__secondary" disabled={busy} onClick={() => setDraft(null)}>
              {t('tools.cancel', { defaultValue: 'Cancel' })}
            </button>
          </div>
          {error && <p className="v2-connector-aside__note" role="alert">{error}</p>}
          {joinPolicyFixPodId === draft.podId && (
            <button type="button" className="v2-connector-aside__secondary" disabled={busy} onClick={() => { void fixJoinPolicy(); }}>
              {t('tools.makePodInviteOnly', { defaultValue: 'Make this pod invite-only' })}
            </button>
          )}
          {policyFixedPodId === draft.podId && (
            <p className="v2-connector-aside__note" role="status">{t('tools.podInviteOnlyNow', { defaultValue: 'This pod is invite-only. Select Grant to continue.' })}</p>
          )}
        </section>
      </aside>
    );
  };

  const renderAside = (grant: ToolGrant) => {
    const dead = isDead(grant, now);
    const podId = grantPodId(grant);
    const granter = memberName(grant.grantedBy);
    const revokedBy = memberName(grant.revokedBy);
    const entry = entryFor(grant);
    const counts = trail?.counts;
    return (
      <aside className="v2-connectors__aside v2-tools__aside" aria-label={t('tools.grantDetails', { defaultValue: 'Grant details' })}>
        <section className="v2-connector-aside__card">
          <p className="v2-connector-aside__eyebrow">{t('tools.grant', { defaultValue: 'grant' })}</p>
          <h2>{toolLabel(grant)} · {grant.target.kind === 'pod' ? podName(grant.target.id) : seatLabel(podId, grant.target.id)}</h2>
          <p>
            {granter
              ? t('tools.grantedByOn', { defaultValue: 'Granted by {{member}} {{rel}}.', member: granter, rel: localizeRelativeTime(grant.createdAt, t, { now, pastEvent: true }) })
              : t('tools.grantedOn', { defaultValue: 'Granted {{rel}}.', rel: localizeRelativeTime(grant.createdAt, t, { now, pastEvent: true }) })}
            {t('tools.sentenceSeparator', { defaultValue: ' ' })}
            {grant.revokedAt
              ? (revokedBy
                ? t('tools.endedRevokedBy', { defaultValue: 'Revoked by {{member}} {{rel}}.', member: revokedBy, rel: localizeRelativeTime(grant.revokedAt, t, { now, pastEvent: true }) })
                : t('tools.endedRevoked', { defaultValue: 'Revoked {{rel}}.', rel: localizeRelativeTime(grant.revokedAt, t, { now, pastEvent: true }) }))
              : (isExpired(grant, now)
                ? t('tools.endedExpired', { defaultValue: 'Expired {{rel}}.', rel: localizeRelativeTime(grant.expiresAt, t, { now }) })
                : t('tools.endsRel', { defaultValue: 'Ends {{rel}}.', rel: localizeRelativeTime(grant.expiresAt, t, { now }) }))}
          </p>
          <dl className="v2-tools__facts">
            <dt>{t('tools.agentsAllowed', { defaultValue: 'agents allowed' })}</dt>
            <dd>{audienceLabels(grant)}</dd>
            <dt><span className="v2-tools__mode" aria-hidden="true"><ModeGlyph mode={grant.writeMode} /></span>{grantModeLabel(grant)}</dt>
            <dd>{grant.tools.length ? grant.tools.map((tool) => <code key={tool}>{tool}</code>) : t('tools.noTools', { defaultValue: 'no tools on the allow-list' })}</dd>
            <dt>{t('tools.asksFirst', { defaultValue: 'asks a person first' })}</dt>
            <dd>{asksFirst(grant)}</dd>
            {(grant.byoAgents || []).length > 0 && (
              <>
                <dt>{t('tools.byo.namedHeading')}</dt>
                <dd>
                  {(grant.byoAgents || []).map((agentId) => {
                    const name = seatLabel(podId, agentId);
                    const sandbox = grant.byoConsent?.agents.find((agent) => agent.userId === agentId)?.sandbox;
                    return (
                      <span key={agentId} className="v2-connector-aside__actions">
                        <span className="v2-connector-aside__conn">{byoNamedLine(name, sandbox)}</span>
                        {!dead && isGranter(grant) && !grant.parentGrantId && (
                          <button type="button" className="v2-connector-aside__secondary" disabled={busy} aria-label={t('tools.byo.removeLabel', { agent: name })} onClick={() => { void removeByoAgent(grant, agentId, name); }}>
                            {t('tools.byo.remove')}
                          </button>
                        )}
                      </span>
                    );
                  })}
                  {!dead && isGranter(grant) && !grant.parentGrantId && <span className="v2-tools__hint">{t('tools.byo.removeHint')}</span>}
                </dd>
              </>
            )}
            {grant.budget?.calls !== undefined && (
              <>
                <dt>{t('tools.budget', { defaultValue: 'budget' })}</dt>
                <dd>{grant.budget.windowMs
                  ? t('tools.budgetWindow', { defaultValue: '{{calls}} calls per {{window}}', calls: grant.budget.calls, window: localizeWindow(grant.budget.windowMs, t) })
                  : t('tools.budgetTotal', { defaultValue: '{{calls}} calls', calls: grant.budget.calls })}</dd>
              </>
            )}
          </dl>
          {/* The granter is the connection's owner (the hosted mint refuses anyone
              else), so the page they reach is the one that bounds this grant. */}
          {!dead && isGranter(grant) && entry?.connectionType === 'hosted-mcp' && entry.available && entry.accessPage && (
            <p className="v2-connector-aside__note">{renderAccessLink(entry)}</p>
          )}
          {staleAfterChange?.oldGrantId === grant.grantId && (
            <div className="v2-connector-aside__actions" role="alert">
              <p className="v2-connector-aside__note">{t('tools.staleAfterChange', { defaultValue: 'The new grant is live. This old one still is too — its revoke did not go through.' })}</p>
              <button type="button" className="v2-connector-aside__primary" disabled={busy} onClick={() => { void retryStaleRevoke(); }}>
                {t('tools.revokeOld', { defaultValue: 'Revoke the old grant' })}
              </button>
            </div>
          )}
          {!dead && isGranter(grant) && staleAfterChange?.oldGrantId !== grant.grantId && (confirmRevoke === grant.grantId ? (
            <div className="v2-connector-aside__actions">
              <button type="button" className="v2-connector-aside__primary" disabled={busy} onClick={() => { void revoke(grant); }}>
                {t('tools.revokeConfirm', { defaultValue: 'Yes, revoke it' })}
              </button>
              <button type="button" className="v2-connector-aside__secondary" disabled={busy} onClick={() => setConfirmRevoke(null)}>
                {t('tools.keep', { defaultValue: 'Keep it' })}
              </button>
            </div>
          ) : (
            <div className="v2-connector-aside__actions">
              {entry && (
                <button type="button" className="v2-connector-aside__secondary" onClick={() => openDraft(entry, grant)}>
                  {t('tools.changeAccess', { defaultValue: 'Change access' })}
                </button>
              )}
              {/* Direction A rule 2: Revoke is the non-deciding act beside Change access, so it is the ✕ (the Deny precedent); it still asks to confirm. */}
              <button
                type="button"
                className="v2-connector-aside__secondary v2-connector-aside__icon"
                title={t('tools.revoke', { defaultValue: 'Revoke' })}
                aria-label={t('tools.revoke', { defaultValue: 'Revoke' })}
                onClick={() => setConfirmRevoke(grant.grantId)}
              >
                <ActGlyph name="deny" />
              </button>
            </div>
          ))}
          {isGranter(grant) && renderDisconnect(entry, 'aside')}
          {error && <p className="v2-connector-aside__note" role="alert">{error}</p>}
        </section>
        <section className="v2-connector-aside__card">
          <p className="v2-connector-aside__eyebrow">{t('tools.trail', { defaultValue: 'trail' })}</p>
          <div className="v2-tools__counts" aria-label={t('tools.counts', { defaultValue: 'Call counts' })}>
            <div className="v2-tools__count"><strong>{counts ? counts.total : '—'}</strong><span>{t('tools.calls', { defaultValue: 'calls' })}</span></div>
            <div className="v2-tools__count"><strong>{counts ? counts.refused : '—'}</strong><span>{t('tools.refused', { defaultValue: 'refused' })}</span></div>
            <div className="v2-tools__count"><strong>{counts ? counts.pending_approval : '—'}</strong><span>{t('tools.awaiting', { defaultValue: 'awaiting a person' })}</span></div>
          </div>
          {trailError && <p className="v2-connector-aside__note">{t('tools.trailError', { defaultValue: 'Could not read the trail.' })}</p>}
          {trail && trail.calls.length === 0 && <p className="v2-connector-aside__note">{t('tools.trailEmpty', { defaultValue: 'No calls yet.' })}</p>}
          {trail && trail.calls.length > 0 && (
            <ol className="v2-tools__trail">
              {trail.calls.map((line) => (
                <li key={line.callId} className="v2-tools__trail-line">
                  <span><span className="v2-tools__outcome" title={outcomeLabel(line.outcome)} aria-hidden="true"><OutcomeGlyph outcome={line.outcome} /></span>{seatLabel(podId, line.agentUserId)} · {line.tool} · {outcomeLabel(line.outcome)}{line.reason && (line.outcome === 'refused' || line.outcome === 'failed') ? <span className="v2-tools__trail-reason"> · {reasonLabel(line.reason)}</span> : null}</span>
                  <span className="v2-tools__trail-when">{localizeRelativeTime(line.at, t, { now, pastEvent: true })}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </aside>
    );
  };

  return { renderManualRevokeNotice, renderLinearWriteNote, renderDisconnect, renderHiddenConnection, renderRow, renderAccessLink, renderKeyForm, renderKeyGuidance, renderEntryActions, renderEntryNote, renderGithubAppSetup, renderDraft, renderAside };
};
