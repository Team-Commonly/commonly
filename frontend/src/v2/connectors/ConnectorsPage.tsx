// The Connectors page, rebuilt from the d215 artboard (TASK-733): one logo grid for
// channels and tools. A tile's logo carries its name, state is a corner mark,
// descriptions are reveal-only, and what is not offered folds into "+N off". An
// unconnected tile reveals a popover with the act; a connected one opens a drawer
// that holds the panels the old page's aside held, verbs and copy unchanged.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { catalogDescription } from '../utils/connectorCatalogDescription';
import { ADD_PLATFORMS, TYPE_LABELS } from './channelModel';
import type { ListItem } from './channelModel';
import { entryCovers, entryIsGranted, isDead } from './toolModel';
import type { ToolCatalogEntry, ToolGrant } from './toolModel';
import { useChannelConnectors } from './useChannelConnectors';
import { useToolConnectors } from './useToolConnectors';
import { useToolPanels } from './ToolPanels';
import { usePhone } from './usePhone';
import ChannelPanel from './ChannelPanel';
import ConnectorDrawer from './ConnectorDrawer';
import ConnectorLogo from './ConnectorLogo';
import ConnectorPopover from './ConnectorPopover';
import ConnectorTile from './ConnectorTile';
import type { TileDot } from './ConnectorTile';
import './connectors.css';

type Filter = 'all' | 'channels' | 'tools';

interface Pop {
  key: string;
  anchor: HTMLElement;
}

const ASK_HREF = 'https://github.com/Team-Commonly/commonly/issues/new?title=Connector%20request';
const MAX_CHIPS = 3;
const FILTERS: Filter[] = ['all', 'channels', 'tools'];
// A brand name, not translatable copy.
const GITHUB_BRAND = 'GitHub';

const SearchGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
  </svg>
);

const ConnectorsPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const c = useChannelConnectors();
  const m = useToolConnectors(c.podList, c.hostedMcpManualRevoke);
  const tp = useToolPanels(m);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [pop, setPop] = useState<Pop | null>(null);
  const [toolKey, setToolKey] = useState<string | null>(null);
  // The gone connector whose tile opened its list of grants (TASK-754).
  const [orphanKey, setOrphanKey] = useState<string | null>(null);
  const [offOpen, setOffOpen] = useState({ channels: false, tools: false });
  const phone = usePhone();
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const tileRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const q = search.trim().toLowerCase();
  const { setQuery } = m;
  const onSearch = (value: string) => {
    setSearch(value);
    setQuery(value);
  };

  // ---- channels ----
  const channelItems = useMemo(() => c.items.filter((item) => {
    if (!q) return true;
    return (c.itemLabel(item) || '').toLowerCase().includes(q);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [c.items, q]);
  const channelInactive = (item: ListItem): boolean => {
    const row = c.rowForItem(item);
    return Boolean(row.muted || row.notEnabled);
  };
  const liveChannels = channelItems.filter((item) => !channelInactive(item));
  const offChannels = channelItems.filter(channelInactive);

  const hasInstallation = (type: string): boolean => c.connectors.some(
    (connector) => connector.type === type && Boolean(connector.installationId),
  );
  const availableProviders = c.catalog
    ? c.catalog.filter((entry) => entry.available && entry.offered !== false && !entry.installation).map((entry) => ({ type: entry.installableId }))
    : ADD_PLATFORMS.filter((provider) => provider.enabled && !hasInstallation(provider.type));

  // ---- tools ----
  const grants = m.grants || [];
  const toolEntries = m.catalog.filter((entry) => (
    !q || entry.label.toLowerCase().includes(q) || entry.tools.some((tool) => tool.name.toLowerCase().includes(q))
  ));
  const toolGranted = (entry: ToolCatalogEntry): boolean => entryIsGranted(entry, grants, m.now);
  const grantsOf = (entry: ToolCatalogEntry) => grants.filter((grant) => entryCovers(entry, grant));
  const hiddenOf = (entry: ToolCatalogEntry) => m.hiddenConnections.filter((connection) => connection.entryId === entry.entryId);
  const toolOff = (entry: ToolCatalogEntry): boolean => !entry.available && !toolGranted(entry);
  const liveTools = toolEntries.filter((entry) => !toolOff(entry));
  const offTools = toolEntries.filter(toolOff);
  const orphanHidden = m.hiddenConnections.filter((connection) => (
    !m.catalog.some((entry) => entry.entryId === connection.entryId)
    && (!q || connection.label.toLowerCase().includes(q))
  ));
  // A grant whose catalogue entry is gone (retired or unreadable) has no tile, but it
  // is still live access: it stays listed so it can still be seen and revoked. A dead
  // one is not access any more, so it leaves the list (TASK-752); the Connectors trail
  // keeps the record.
  const orphanGrants = grants.filter((grant) => (
    !m.catalog.some((entry) => entryCovers(entry, grant))
    && !isDead(grant, m.now)
    && (!q || m.toolLabel(grant).toLowerCase().includes(q))
  ));
  // One tile per gone connector, not per grant: two grants on one connector
  // would otherwise be two tiles with one name (TASK-754).
  const orphanKeyOf = (grant: ToolGrant): string => grant.connector?.id || grant.tools[0]?.split('.')[0] || grant.grantId;
  const orphanGroups = new Map<string, ToolGrant[]>();
  orphanGrants.forEach((grant) => {
    const key = orphanKeyOf(grant);
    orphanGroups.set(key, [...(orphanGroups.get(key) || []), grant]);
  });
  const orphanGroup = orphanKey ? orphanGroups.get(orphanKey) || null : null;
  const toolHasDrawer = (entry: ToolCatalogEntry): boolean => grantsOf(entry).length > 0 || hiddenOf(entry).length > 0;

  // ---- what is open ----
  const drawerItem = c.items.find((item) => item.key === c.selectedKey) || null;
  const channelDrawerOpen = c.adding || drawerItem !== null;
  const toolEntry = toolKey ? m.catalog.find((entry) => entry.installableId === toolKey) || null : null;
  const toolDrawerOpen = !channelDrawerOpen && Boolean(m.draft || m.githubAppSetup || toolEntry || m.selected || orphanGroup);

  // Opening the phone search puts the cursor in the box.
  useEffect(() => { if (searchOpen) searchRef.current?.focus(); }, [searchOpen]);

  // Crossing the phone breakpoint remounts every tile, so a reveal's anchor is gone.
  useEffect(() => { setPop(null); }, [phone]);

  // A drawer and a reveal never show together, and a reveal that opened a drawer
  // stays closed when the drawer does.
  useEffect(() => {
    if (channelDrawerOpen || toolDrawerOpen) setPop(null);
  }, [channelDrawerOpen, toolDrawerOpen]);

  // Coming back from a hosted-MCP disconnect that needs a manual revoke, the notice
  // lives in its tile's reveal or drawer: open that tile once so it is not missed.
  const revokeNotice = c.hostedMcpManualRevoke;
  const revokeEntry = revokeNotice
    ? m.catalog.find((entry) => entry.entryId === revokeNotice.entryId
      && entry.connections.some((connection) => connection.connectionId === revokeNotice.connectionId))
    : null;
  const revealedRevoke = useRef(false);
  useEffect(() => {
    if (!revokeEntry || revealedRevoke.current) return;
    const anchor = tileRefs.current[`tool:${revokeEntry.installableId}`];
    if (!anchor) return;
    revealedRevoke.current = true;
    if (toolHasDrawer(revokeEntry)) setToolKey(revokeEntry.installableId);
    else setPop({ key: `tool:${revokeEntry.installableId}`, anchor });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revokeEntry?.installableId, container]);

  const closeTools = useCallback(() => {
    setToolKey(null);
    setOrphanKey(null);
    m.setSelectedId(null);
    m.setDraft(null);
    m.setGithubAppSetup(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const closeChannels = useCallback(() => {
    c.setSelectedKey(null);
    c.setAddingType(null);
    c.setConfirmRemove(null);
    c.setExpandedGate(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const closePop = useCallback(() => setPop(null), []);

  const openChannel = (item: ListItem, event: React.MouseEvent<HTMLButtonElement>) => {
    closeTools();
    // An installed provider this instance no longer offers has no panel: it gets the reveal (the reason and Ask).
    const hasConnection = item.connector !== null || (item.kind === 'catalog' && item.entry.available && Boolean(item.entry.installation));
    if (hasConnection) {
      setPop(null);
      c.selectItem(item);
      return;
    }
    closeChannels();
    setPop({ key: item.key, anchor: event.currentTarget });
  };

  const openTool = (entry: ToolCatalogEntry, event: React.MouseEvent<HTMLButtonElement>) => {
    closeChannels();
    m.setDraft(null);
    m.setGithubAppSetup(null);
    m.setSelectedId(null);
    setOrphanKey(null);
    if (toolHasDrawer(entry)) {
      setPop(null);
      setToolKey(entry.installableId);
      return;
    }
    setToolKey(null);
    setPop({ key: `tool:${entry.installableId}`, anchor: event.currentTarget });
  };

  // A gone connector has no entry drawer. One grant opens its own details;
  // several open their list, as an entry's tile does.
  const openOrphan = (key: string, group: ToolGrant[]) => {
    closeChannels();
    setPop(null);
    setToolKey(null);
    m.setDraft(null);
    m.setGithubAppSetup(null);
    m.setConfirmRevoke(null);
    if (group.length === 1) {
      setOrphanKey(null);
      m.setSelectedId(group[0].grantId);
      return;
    }
    m.setSelectedId(null);
    setOrphanKey(key);
  };

  const openAdd = () => {
    closeTools();
    setPop(null);
    c.setSelectedKey(null);
    c.setAddingType(availableProviders[0]?.type || null);
  };

  // ---- tile builders ----
  const channelDot = (item: ListItem): { kind: TileDot; label: string; pulse?: boolean } | undefined => {
    const row = c.rowForItem(item);
    if (row.muted || row.notEnabled) return undefined;
    const attention = c.needsUser(row) && row.dot !== 'live';
    if (attention) return { kind: 'attention', label: row.line, pulse: row.pulse };
    if (row.dot === 'live') return { kind: 'live', label: row.line, pulse: row.pulse };
    if (row.dot === 'pending') return { kind: 'pending', label: row.line, pulse: row.pulse };
    if (row.dot === 'idle') return { kind: 'idle', label: row.line };
    return undefined;
  };

  const renderChannelTile = (item: ListItem, dim = false) => {
    const label = c.itemLabel(item) || '';
    return (
      <ConnectorTile
        key={item.key}
        ref={(node) => { tileRefs.current[item.key] = node; }}
        type={c.itemType(item)}
        name={label}
        dot={channelDot(item)}
        dim={dim}
        selected={drawerItem?.key === item.key}
        expanded={pop?.key === item.key}
        onClick={(event) => openChannel(item, event)}
      />
    );
  };

  const toolDot = (entry: ToolCatalogEntry): { kind: TileDot; label: string } | undefined => (
    toolGranted(entry)
      ? { kind: 'live', label: t('tools.granted', { defaultValue: 'Granted' }) }
      : undefined
  );

  const renderToolTile = (entry: ToolCatalogEntry, dim = false) => (
    <ConnectorTile
      key={entry.installableId}
      ref={(node) => { tileRefs.current[`tool:${entry.installableId}`] = node; }}
      type={entry.installableId}
      name={entry.label}
      dot={toolDot(entry)}
      dim={dim}
      lock={entry.installableId === 'github' && entry.connections.length === 0 && !toolGranted(entry)
        ? t('tools.adminOnce', { defaultValue: 'An admin installs this once' })
        : undefined}
      beta={entry.entryId === 'atlassian'
        ? { word: t('tools.beta', { defaultValue: 'beta' }), title: t('tools.readInTesting', { defaultValue: 'read in testing' }) }
        : undefined}
      selected={toolEntry?.installableId === entry.installableId}
      expanded={pop?.key === `tool:${entry.installableId}`}
      onClick={(event) => openTool(entry, event)}
    />
  );

  // A live grant whose entry is gone is still access (TASK-752), so it keeps a
  // tile in the Tools grid, in the grid's own shape (TASK-754, D223). The
  // server's `connector` names it when the catalogue cannot (TASK-753).
  const renderOrphanTile = ([key, group]: [string, ToolGrant[]]) => (
    <ConnectorTile
      key={`orphan:${key}`}
      type={key}
      name={m.toolLabel(group[0])}
      dot={{ kind: 'live', label: t('tools.granted', { defaultValue: 'Granted' }) }}
      beta={key === 'atlassian'
        ? { word: t('tools.beta', { defaultValue: 'beta' }), title: t('tools.readInTesting', { defaultValue: 'read in testing' }) }
        : undefined}
      selected={orphanKey === key || (group.length === 1 && m.selectedId === group[0].grantId)}
      onClick={() => openOrphan(key, group)}
    />
  );

  // ---- the reveal ----
  const renderPopover = () => {
    if (!pop) return null;
    const channel = c.items.find((item) => item.key === pop.key);
    if (channel) {
      const row = c.rowForItem(channel);
      const label = c.itemLabel(channel) || '';
      const description = channel.kind === 'catalog'
        ? catalogDescription(i18n, channel.entry.installableId, channel.entry.description)
        : row.line;
      return (
        <ConnectorPopover anchor={pop.anchor} container={container} label={label} onClose={closePop}>
          <div className="v2-cx-pop__head"><ConnectorLogo type={c.itemType(channel)} size={28} />{label}</div>
          {description && <p>{description}</p>}
          {(row.muted || row.notEnabled) && row.line && <p className="v2-cx-note">{row.line}</p>}
          {row.detail && <p className="v2-cx-note">{row.detail}</p>}
          <div className="v2-cx-pop__acts">
            {row.action === 'connect' && (
              <button
                type="button"
                className="v2-connector-row__action"
                onClick={() => { setPop(null); c.runAction(channel, 'connect'); }}
              >
                {row.actionLabel || t('connectors.connect', { defaultValue: 'Connect' })}
              </button>
            )}
            {row.notEnabled && (
              <a className="v2-connector-row__action v2-connector-row__action--secondary" href={ASK_HREF}>
                {t('tools.ask', { defaultValue: 'Ask' })}
              </a>
            )}
          </div>
        </ConnectorPopover>
      );
    }
    const entry = m.catalog.find((candidate) => `tool:${candidate.installableId}` === pop.key);
    if (!entry) return null;
    const names = entry.tools.map((tool) => tool.name);
    return (
      <ConnectorPopover anchor={pop.anchor} container={container} label={entry.label} onClose={closePop}>
        <div className="v2-cx-pop__head">
          <ConnectorLogo type={entry.installableId} size={28} />
          {entry.label}
          {entry.entryId === 'atlassian' && (
            <span className="v2-cx-pop__beta" title={t('tools.readInTesting', { defaultValue: 'read in testing' })}>{t('tools.beta', { defaultValue: 'beta' })}</span>
          )}
        </div>
        <p>{catalogDescription(i18n, entry.installableId, entry.description)}</p>
        {names.length > 0 && (
          <div className="v2-cx-pop__chips">
            {names.slice(0, MAX_CHIPS).map((name) => <span key={name} className="v2-cx-chip">{name}</span>)}
            {names.length > MAX_CHIPS && <span className="v2-cx-chip">+{names.length - MAX_CHIPS}</span>}
          </div>
        )}
        {tp.renderEntryNote(entry)}
        <div className="v2-cx-pop__acts">{tp.renderEntryActions(entry)}</div>
      </ConnectorPopover>
    );
  };

  // ---- the drawer ----
  const renderAddForm = () => {
    if (c.pods !== null && c.pods.length === 0) {
      return (
        <div className="v2-connectors__empty-pods">
          <p>{t('connectors.noPodsToConnect', { defaultValue: 'No pod yet. Create one, then come back to connect a channel.' })}</p>
          <button type="button" className="v2-connectors__create" onClick={() => navigate('/v2?newPod=1')}>
            {t('connectors.createPod', { defaultValue: 'Create a pod' })}
          </button>
        </div>
      );
    }
    return (
      <div className="v2-connectors__new-row v2-connectors__new-row--aside">
        <div className="v2-connectors__providers" role="group" aria-label={t('connectors.provider', { defaultValue: 'Channel provider' })}>
          {availableProviders.map((provider) => (
            <button
              key={provider.type}
              type="button"
              className={`v2-connectors__provider${c.addingType === provider.type ? ' v2-connectors__provider--selected' : ''}`}
              onClick={() => c.setAddingType(provider.type)}
            >
              {TYPE_LABELS[provider.type] || provider.type}
            </button>
          ))}
        </div>
        <select
          ref={c.podPickerRef}
          className="v2-connectors__select"
          value={c.newPodId}
          onChange={(event) => c.setNewPodId(event.target.value)}
          aria-label={t('connectors.podPicker', { defaultValue: 'Pod to bridge' })}
        >
          {c.podList.map((pod) => <option key={pod._id} value={pod._id}>{pod.name}</option>)}
        </select>
        <button type="button" className="v2-connectors__create" disabled={!c.newPodId || c.creating || !c.addingType} onClick={c.createConnector}>
          {c.creating ? t('connectors.creating', { defaultValue: 'Connecting…' }) : t('connectors.connect', { defaultValue: 'Connect' })}
        </button>
      </div>
    );
  };

  const renderChannelDrawer = () => {
    if (c.adding) {
      const title = t('connectors.connectChannel', { defaultValue: 'Connect a channel' });
      return (
        <ConnectorDrawer notices={noticeBlock} type={c.addingType || 'slack'} title={title} onClose={closeChannels}>
          <section className="v2-connector-aside__step">
            <p className="v2-connector-aside__eyebrow">{t('connectors.nextStep', { defaultValue: 'Next step' })}</p>
            {renderAddForm()}
          </section>
        </ConnectorDrawer>
      );
    }
    if (!drawerItem) return null;
    return (
      <ConnectorDrawer notices={noticeBlock} type={c.itemType(drawerItem)} title={c.itemLabel(drawerItem) || ''} onClose={closeChannels}>
        <ChannelPanel m={c} item={drawerItem} />
      </ConnectorDrawer>
    );
  };

  const renderToolDrawer = () => {
    if (m.draft) {
      return (
        <ConnectorDrawer notices={noticeBlock} type={m.draftEntry?.installableId || 'github'} title={m.draftEntry?.label || t('tools.title', { defaultValue: 'Tools' })} onClose={closeTools}>
          {tp.renderDraft()}
        </ConnectorDrawer>
      );
    }
    if (m.githubAppSetup) {
      return (
        <ConnectorDrawer notices={noticeBlock} type="github" title={GITHUB_BRAND} onClose={closeTools}>
          {tp.renderGithubAppSetup()}
        </ConnectorDrawer>
      );
    }
    if (!toolEntry) {
      if (orphanKey && orphanGroup) {
        return (
          <ConnectorDrawer notices={noticeBlock} type={orphanKey} title={m.toolLabel(orphanGroup[0])} onClose={closeTools}>
            <div className="v2-cx-list">{orphanGroup.map(tp.renderRow)}</div>
            {m.selected && tp.renderAside(m.selected)}
          </ConnectorDrawer>
        );
      }
      if (!m.selected) return null;
      return (
        <ConnectorDrawer notices={noticeBlock} type={orphanKeyOf(m.selected)} title={m.toolLabel(m.selected)} onClose={closeTools}>
          {tp.renderAside(m.selected)}
        </ConnectorDrawer>
      );
    }
    const entryGrants = grantsOf(toolEntry);
    const liveGrants = entryGrants.filter((grant) => !isDead(grant, m.now));
    const deadGrants = entryGrants.filter((grant) => isDead(grant, m.now));
    return (
      <ConnectorDrawer notices={noticeBlock} type={toolEntry.installableId} title={toolEntry.label} onClose={closeTools}>
        {!toolGranted(toolEntry) && (
          <div className="v2-cx-drawer__offer">
            <p>{catalogDescription(i18n, toolEntry.installableId, toolEntry.description)}</p>
            {tp.renderEntryNote(toolEntry)}
            <div className="v2-cx-pop__acts">{tp.renderEntryActions(toolEntry)}</div>
          </div>
        )}
        <div className="v2-cx-list">
          {liveGrants.map(tp.renderRow)}
          {deadGrants.length > 0 && (
            <>
              <p className="v2-cx-group__title">{t('connectors.inactiveFold', { defaultValue: 'inactive · {{n}}', n: deadGrants.length })}</p>
              {deadGrants.map(tp.renderRow)}
            </>
          )}
          {hiddenOf(toolEntry).map(tp.renderHiddenConnection)}
        </div>
        {m.selected && tp.renderAside(m.selected)}
      </ConnectorDrawer>
    );
  };

  // ---- the page ----
  const connectedChannels = c.connectedCount;
  const grantedTools = m.catalog.filter(toolGranted).length;
  const onCount = connectedChannels + grantedTools;
  // Counted over everything, not the search result, so the header holds still while typing.
  const offeredCount = c.items.filter((item) => !channelInactive(item)).length
    + m.catalog.filter((entry) => !toolOff(entry)).length;
  const availableCount = offeredCount - onCount;
  // An orphan grant's tile is live too (TASK-754), so it counts as on. It was
  // never offered, so it leaves `available` alone.
  const orphanOn = new Set(grants
    .filter((grant) => !m.catalog.some((entry) => entryCovers(entry, grant)) && !isDead(grant, m.now))
    .map(orphanKeyOf)).size;
  const meta = t('connectors.meta', { defaultValue: '{{on}} on · {{available}} available', on: onCount + orphanOn, available: Math.max(0, availableCount) });

  const showChannels = filter !== 'tools';
  const showTools = filter !== 'channels';
  const errorText = c.hostedMcpCallbackError || c.error || c.slackCallbackError || (
    !m.draft && !m.selected && !m.githubAppSetup ? m.error : null
  );
  const noticeBlock = (
    <>
      {errorText && <p className="v2-cx-error" role="alert">{errorText}</p>}
      {m.removedHiddenNotice && (
        <p className="v2-cx-note" role="status">
          {m.removedHiddenNotice.revokePage
            ? <>{t('tools.removedReviewProvider', { defaultValue: 'Connection removed. Review its access at {{label}}.', label: m.removedHiddenNotice.label })} <a href={m.removedHiddenNotice.revokePage} target="_blank" rel="noopener noreferrer">{t('tools.openProviderSettings', { defaultValue: 'Open provider settings' })}</a></>
            : t('tools.disconnected', { defaultValue: 'Disconnected {{label}}.', label: m.removedHiddenNotice.label })}
        </p>
      )}
    </>
  );
  const nothing = !c.loading && q && liveChannels.length + offChannels.length + toolEntries.length + orphanHidden.length + orphanGrants.length === 0;

  const offToggle = (group: 'channels' | 'tools', count: number) => (count > 0 ? (
    <button
      type="button"
      className="v2-cx-off"
      aria-expanded={offOpen[group]}
      onClick={() => setOffOpen((current) => ({ ...current, [group]: !current[group] }))}
    >
      {t('connectors.offCount', { defaultValue: '+{{n}} off', n: count })}
    </button>
  ) : null);

  const filterSeg = (
    <div className="v2-cx-seg" role="group" aria-label={t('connectors.filterLabel', { defaultValue: 'Show' })}>
      {FILTERS.map((value) => (
        <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>
          {t(`connectors.filter.${value}`, { defaultValue: value === 'all' ? 'All' : value === 'channels' ? 'Channels' : 'Tools' })}
        </button>
      ))}
    </div>
  );
  const searchBox = (
    <label className="v2-cx-search">
      <SearchGlyph />
      <input
        ref={searchRef}
        type="search"
        value={search}
        placeholder={t('connectors.search', { defaultValue: 'Search' })}
        aria-label={t('connectors.search', { defaultValue: 'Search' })}
        onChange={(event) => onSearch(event.target.value)}
      />
    </label>
  );
  // Phone: one grid, channels then tools, the add tile last, one "+N off" under it.
  const offTotal = (showChannels ? offChannels.length : 0) + (showTools ? offTools.length + orphanHidden.length : 0);
  const phoneOffOpen = offOpen.channels || offOpen.tools;

  return (
    <div className="v2-cx">
      <header className="v2-cx-head">
        <h1>{t('connectors.title', { defaultValue: 'Connectors' })}</h1>
        {!phone && !c.loading && <span className="v2-cx-head__meta">{meta}</span>}
        <span className="v2-cx-head__sp" />
        {phone ? (
          <button
            type="button"
            className="v2-cx-searchbtn"
            aria-label={t('connectors.search', { defaultValue: 'Search' })}
            aria-expanded={searchOpen || Boolean(q)}
            onClick={() => setSearchOpen((open) => !open)}
          >
            <SearchGlyph />
          </button>
        ) : (
          <>
            {searchBox}
            {filterSeg}
          </>
        )}
      </header>

      {c.loading && <div className="v2-connectors__loading">{t('connectors.loading', { defaultValue: 'Loading connectors…' })}</div>}

      {!c.loading && (
        <div className="v2-cx-body" ref={setContainer}>
          <div className="v2-cx-inner">
            {phone && filterSeg}
            {phone && (searchOpen || q) && searchBox}
            {!channelDrawerOpen && !toolDrawerOpen && noticeBlock}

            {phone && (
              <>
                <div className="v2-cx-grid">
                  {showChannels && liveChannels.map((item) => renderChannelTile(item))}
                  {showTools && liveTools.map((entry) => renderToolTile(entry))}
                  {showTools && [...orphanGroups].map(renderOrphanTile)}
                  {phoneOffOpen && showChannels && offChannels.map((item) => renderChannelTile(item, true))}
                  {phoneOffOpen && showTools && offTools.map((entry) => renderToolTile(entry, true))}
                  {showChannels && availableProviders.length > 0 && !q && (
                    <ConnectorTile
                      type="add"
                      name={t('connectors.addChannelTile', { defaultValue: 'Channel' })}
                      add
                      onClick={openAdd}
                    />
                  )}
                </div>
                {offTotal > 0 && (
                  <button
                    type="button"
                    className="v2-cx-off v2-cx-off--phone"
                    aria-expanded={phoneOffOpen}
                    onClick={() => setOffOpen({ channels: !phoneOffOpen, tools: !phoneOffOpen })}
                  >
                    {t('connectors.offCount', { defaultValue: '+{{n}} off', n: offTotal })}
                  </button>
                )}
                {showTools && phoneOffOpen && orphanHidden.length > 0 && (
                  <div className="v2-cx-list">{orphanHidden.map(tp.renderHiddenConnection)}</div>
                )}
              </>
            )}

            {!phone && showChannels && (
              <section className="v2-cx-group" aria-label={t('connectors.channelsGroup', { defaultValue: 'Channels' })}>
                <h2 className="v2-cx-group__title">
                  {t('connectors.channelsGroup', { defaultValue: 'Channels' })}
                  {offToggle('channels', offChannels.length)}
                </h2>
                <div className="v2-cx-grid">
                  {liveChannels.map((item) => renderChannelTile(item))}
                  {offOpen.channels && offChannels.map((item) => renderChannelTile(item, true))}
                  {availableProviders.length > 0 && !q && (
                    <ConnectorTile
                      type="add"
                      name={t('connectors.addChannelTile', { defaultValue: 'Channel' })}
                      add
                      onClick={openAdd}
                    />
                  )}
                </div>
              </section>
            )}

            {!phone && showTools && (
              <section className="v2-cx-group" aria-label={t('tools.title', { defaultValue: 'Tools' })}>
                <h2 className="v2-cx-group__title">
                  {t('tools.title', { defaultValue: 'Tools' })}
                  {offToggle('tools', offTools.length + orphanHidden.length)}
                </h2>
                <div className="v2-cx-grid">
                  {liveTools.map((entry) => renderToolTile(entry))}
                  {[...orphanGroups].map(renderOrphanTile)}
                  {offOpen.tools && offTools.map((entry) => renderToolTile(entry, true))}
                </div>
                {offOpen.tools && orphanHidden.length > 0 && (
                  <div className="v2-cx-list">{orphanHidden.map(tp.renderHiddenConnection)}</div>
                )}
              </section>
            )}

            {nothing && <p className="v2-cx-note">{t('tools.nothingMatches', { defaultValue: 'Nothing matches.' })}</p>}
          </div>
          {!channelDrawerOpen && !toolDrawerOpen && renderPopover()}
          {renderChannelDrawer() || (toolDrawerOpen ? renderToolDrawer() : null)}
        </div>
      )}
    </div>
  );
};

export default ConnectorsPage;
