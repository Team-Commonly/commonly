// The Connectors page, rebuilt from the d215 artboard (TASK-733): one logo grid for
// channels and tools. A tile's logo carries its name, state is a corner mark,
// descriptions are reveal-only, and what is not offered folds into "+N off". An
// unconnected tile reveals a popover with the act; a connected one opens a drawer
// that holds the panels the old page's aside held, verbs and copy unchanged.
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { catalogDescription } from '../utils/connectorCatalogDescription';
import { ADD_PLATFORMS, TYPE_LABELS } from './channelModel';
import type { ListItem } from './channelModel';
import { entryCovers, entryIsGranted, isDead } from './toolModel';
import type { ToolCatalogEntry } from './toolModel';
import { useChannelConnectors } from './useChannelConnectors';
import { useToolConnectors } from './useToolConnectors';
import { useToolPanels } from './ToolPanels';
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
  const [offOpen, setOffOpen] = useState({ channels: false, tools: false });
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
  const toolHasDrawer = (entry: ToolCatalogEntry): boolean => grantsOf(entry).length > 0 || hiddenOf(entry).length > 0;

  // ---- what is open ----
  const drawerItem = c.items.find((item) => item.key === c.selectedKey) || null;
  const channelDrawerOpen = c.adding || drawerItem !== null;
  const toolEntry = toolKey ? m.catalog.find((entry) => entry.installableId === toolKey) || null : null;
  const toolDrawerOpen = !channelDrawerOpen && Boolean(m.draft || m.githubAppSetup || toolEntry);

  const closeTools = useCallback(() => {
    setToolKey(null);
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
    const hasConnection = item.connector !== null || (item.kind === 'catalog' && Boolean(item.entry.installation));
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
    if (toolHasDrawer(entry)) {
      setPop(null);
      setToolKey(entry.installableId);
      return;
    }
    setToolKey(null);
    setPop({ key: `tool:${entry.installableId}`, anchor: event.currentTarget });
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
        <ConnectorDrawer type={c.addingType || 'slack'} title={title} onClose={closeChannels}>
          <section className="v2-connector-aside__step">
            <p className="v2-connector-aside__eyebrow">{t('connectors.nextStep', { defaultValue: 'Next step' })}</p>
            {renderAddForm()}
          </section>
        </ConnectorDrawer>
      );
    }
    if (!drawerItem) return null;
    return (
      <ConnectorDrawer type={c.itemType(drawerItem)} title={c.itemLabel(drawerItem) || ''} onClose={closeChannels}>
        <ChannelPanel m={c} item={drawerItem} />
      </ConnectorDrawer>
    );
  };

  const renderToolDrawer = () => {
    if (m.draft) {
      return (
        <ConnectorDrawer type={m.draftEntry?.installableId || 'github'} title={m.draftEntry?.label || t('tools.title', { defaultValue: 'Tools' })} onClose={closeTools}>
          {tp.renderDraft()}
        </ConnectorDrawer>
      );
    }
    if (m.githubAppSetup) {
      return (
        <ConnectorDrawer type="github" title="GitHub" onClose={closeTools}>
          {tp.renderGithubAppSetup()}
        </ConnectorDrawer>
      );
    }
    if (!toolEntry) return null;
    const entryGrants = grantsOf(toolEntry);
    const liveGrants = entryGrants.filter((grant) => !isDead(grant, m.now));
    const deadGrants = entryGrants.filter((grant) => isDead(grant, m.now));
    return (
      <ConnectorDrawer type={toolEntry.installableId} title={toolEntry.label} onClose={closeTools}>
        {!toolGranted(toolEntry) && (
          <div className="v2-cx-drawer__offer">
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
  const availableCount = liveChannels.length + liveTools.length - onCount;
  const meta = t('connectors.meta', { defaultValue: '{{on}} on · {{available}} available', on: onCount, available: Math.max(0, availableCount) });

  const showChannels = filter !== 'tools';
  const showTools = filter !== 'channels';
  const errorText = c.hostedMcpCallbackError || c.error || c.slackCallbackError || (
    !m.draft && !m.selected && !m.githubAppSetup ? m.error : null
  );
  const nothing = !c.loading && q && liveChannels.length + offChannels.length + toolEntries.length + orphanHidden.length === 0;

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

  return (
    <div className="v2-cx">
      <header className="v2-cx-head">
        <h1>{t('connectors.title', { defaultValue: 'Connectors' })}</h1>
        {!c.loading && <span className="v2-cx-head__meta">{meta}</span>}
        <span className="v2-cx-head__sp" />
        <label className="v2-cx-search">
          <SearchGlyph />
          <input
            type="search"
            value={search}
            placeholder={t('connectors.search', { defaultValue: 'Search' })}
            aria-label={t('connectors.search', { defaultValue: 'Search' })}
            onChange={(event) => onSearch(event.target.value)}
          />
        </label>
        <div className="v2-cx-seg" role="group" aria-label={t('connectors.filterLabel', { defaultValue: 'Show' })}>
          {(['all', 'channels', 'tools'] as Filter[]).map((value) => (
            <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>
              {t(`connectors.filter.${value}`, { defaultValue: value === 'all' ? 'All' : value === 'channels' ? 'Channels' : 'Tools' })}
            </button>
          ))}
        </div>
      </header>

      {c.loading && <div className="v2-connectors__loading">{t('connectors.loading', { defaultValue: 'Loading connectors…' })}</div>}

      {!c.loading && (
        <div className="v2-cx-body" ref={setContainer}>
          <div className="v2-cx-inner">
            {errorText && <p className="v2-cx-error" role="alert">{errorText}</p>}
            {m.removedHiddenNotice && (
              <p className="v2-cx-note" role="status">
                {m.removedHiddenNotice.revokePage
                  ? <>{t('tools.removedReviewProvider', { defaultValue: 'Connection removed. Review its access at {{label}}.', label: m.removedHiddenNotice.label })} <a href={m.removedHiddenNotice.revokePage} target="_blank" rel="noopener noreferrer">{t('tools.openProviderSettings', { defaultValue: 'Open provider settings' })}</a></>
                  : t('tools.disconnected', { defaultValue: 'Disconnected {{label}}.', label: m.removedHiddenNotice.label })}
              </p>
            )}

            {showChannels && (
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

            {showTools && (
              <section className="v2-cx-group" aria-label={t('tools.title', { defaultValue: 'Tools' })}>
                <h2 className="v2-cx-group__title">
                  {t('tools.title', { defaultValue: 'Tools' })}
                  {offToggle('tools', offTools.length + orphanHidden.length)}
                </h2>
                <div className="v2-cx-grid">
                  {liveTools.map((entry) => renderToolTile(entry))}
                  {offOpen.tools && offTools.map((entry) => renderToolTile(entry, true))}
                </div>
                {offOpen.tools && orphanHidden.length > 0 && (
                  <div className="v2-cx-list">{orphanHidden.map(tp.renderHiddenConnection)}</div>
                )}
              </section>
            )}

            {nothing && <p className="v2-cx-note">{t('tools.nothingMatches', { defaultValue: 'Nothing matches.' })}</p>}
          </div>
          {renderPopover()}
          {renderChannelDrawer() || (toolDrawerOpen ? renderToolDrawer() : null)}
        </div>
      )}
    </div>
  );
};

export default ConnectorsPage;
