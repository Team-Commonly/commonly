// The channel's side panel: next step while it is not connected, then relay,
// mode and the pods that reach it. Moved from the old page's aside (TASK-733);
// the verbs and copy are unchanged.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { localizeRelativeTime } from '../utils/localizeRelativeTime';
import {
  BOT_HANDLE,
  connectorPodId,
  groupCode,
  codeIsLive,
  connectorRelativeTimeOptions,
  botMembers,
} from './channelModel';
import type {
  Connector,
  ConnectorAction,
  ConnectorRow,
  ListItem,
} from './channelModel';
import type { ChannelConnectorsModel } from './useChannelConnectors';

interface Props {
  m: ChannelConnectorsModel;
  item: ListItem;
}

const ChannelPanel: React.FC<Props> = ({ m, item: panelItem }) => {
  const { t } = useTranslation();
  const {
    pods,
    busyId,
    confirmRemove,
    setConfirmRemove,
    expandedGate,
    setExpandedGate,
    copied,
    rowRefusal,
    slackLeadChoices,
    setSlackLeadChoices,
    now,
    podList,
    gateModes,
    patchConfig,
    writeGate,
    makeActive,
    regenerateCode,
    authorizeSlack,
    resolveSlackBind,
    remove,
    retry,
    copyCommand,
    rowForItem,
    runAction,
    busyFor,
  } = m;
  // D4: one row per pod the user is in. The switch is the gate; the active pod
  // is where the owner's typed messages land, and it is its own control.
  const renderGates = (connector: Connector) => {
    const gates = connector.config?.gates || {};
    const activePodId = connectorPodId(connector);
    const unlinked = !activePodId;
    return (
      <div className="v2-connector-gates" data-testid="connector-gates">
        <p className="v2-connector-gates__title">
          {unlinked
            ? t('connectors.pickWhere', { defaultValue: 'Pick where your messages go' })
            : t('connectors.gatesTitle', { defaultValue: 'Pods that reach this channel' })}
        </p>
        {podList.length === 0 && (
          <p className="v2-connector-gates__empty">{t('connectors.noPods', { defaultValue: 'Join a pod first.' })}</p>
        )}
        {podList.map((pod) => {
          const gate = gates[pod._id];
          const enabled = gate?.enabled === true;
          const active = String(activePodId || '') === String(pod._id);
          const open = unlinked || expandedGate === pod._id;
          const bots = botMembers(pod);
          const disabled = busyId === connector._id;
          return (
            <div key={pod._id} className={`v2-connector-gate${active ? ' v2-connector-gate--active' : ''}`}>
              <div className="v2-connector-gate__row">
                <button
                  type="button"
                  className="v2-connector-gate__name"
                  aria-expanded={open}
                  onClick={() => setExpandedGate((current) => (current === pod._id ? null : pod._id))}
                >
                  <span className="v2-connector-gate__mark" aria-hidden="true" />
                  <span className="v2-connector-gate__pod">{pod.name}</span>
                  {active && <span className="v2-connector-gate__tag">{t('connectors.activeTag', { defaultValue: 'active' })}</span>}
                </button>
                <span className={`v2-connector-gate__since${enabled ? '' : ' v2-connector-gate__since--off'}`}>
                  {enabled ? t('connectors.sinceWhen', { defaultValue: 'since {{rel}}', rel: localizeRelativeTime(gate?.since, t, { ...connectorRelativeTimeOptions, now }) }) : t('connectors.gateOff', { defaultValue: 'off' })}
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  className="v2-connector-gate__switch"
                  aria-checked={enabled}
                  aria-label={t('connectors.gateSwitch', { defaultValue: 'Relay {{pod}}', pod: pod.name })}
                  checked={enabled}
                  disabled={disabled}
                  onChange={() => { void writeGate(connector, pod._id, { ...gate, enabled: !enabled }); }}
                />
              </div>
              {open && (
                <div className="v2-connector-gate__more">
                  <div className="v2-connector-aside__mode" role="group" aria-label={t('connectors.gateMode', { defaultValue: 'Mode for {{pod}}', pod: pod.name })}>
                    {gateModes.map(([mode, modeLabel]) => {
                      const on = (gate?.mode || undefined) === mode;
                      return (
                        <button
                          key={modeLabel}
                          type="button"
                          className={on ? 'v2-connector-aside__mode-opt v2-connector-aside__mode-opt--on' : 'v2-connector-aside__mode-opt'}
                          disabled={disabled || on}
                          onClick={() => { void writeGate(connector, pod._id, { ...gate, enabled, mode }); }}
                        >
                          {modeLabel}
                        </button>
                      );
                    })}
                  </div>
                  <select
                    className="v2-connectors__select v2-connector-gate__lead"
                    aria-label={t('connectors.gateLead', { defaultValue: 'Lead agent for {{pod}}', pod: pod.name })}
                    value={gate?.lead || ''}
                    disabled={disabled}
                    onChange={(event) => { void writeGate(connector, pod._id, { ...gate, enabled, lead: event.target.value || undefined }); }}
                  >
                    <option value="">{connector.type === 'slack'
                      ? t('connectors.slackLeadNone', { defaultValue: 'No lead selected' })
                      : t('connectors.leadAny', { defaultValue: 'Any agent leads' })}</option>
                    {bots.map((bot) => <option key={bot.username} value={bot.username}>{bot.username}</option>)}
                  </select>
                  {!active && (
                    <button
                      type="button"
                      className="v2-connector-aside__secondary"
                      disabled={disabled}
                      onClick={() => { void makeActive(connector, pod._id); }}
                    >
                      {t('connectors.makeActive', { defaultValue: 'Make active' })}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const renderRemove = (item: ListItem) => (
    confirmRemove === item.key ? (
      <button type="button" className="v2-connector-aside__primary" disabled={busyFor(item)} onClick={() => { void remove(item); }}>
        {t('connectors.removeConfirm', { defaultValue: 'Really remove — the channel goes quiet' })}
      </button>
    ) : (
      <button type="button" className="v2-connector-aside__secondary" onClick={() => setConfirmRemove(item.key)}>
        {t('connectors.remove', { defaultValue: 'Remove' })}
      </button>
    )
  );

  // The parent's non-active states own the aside: one sentence, the verbs the
  // service would honour, and nothing the owner cannot press.
  const renderParentAside = (item: ListItem & { kind: 'catalog' }, row: ConnectorRow) => {
    const status = item.entry.installation?.status || '';
    const busy = busyFor(item);
    return (
      <aside className="v2-connectors__aside" aria-label={t('connectors.channelDetails', { defaultValue: 'Channel details' })}>
        <section className="v2-connector-aside__step">
          <p className="v2-connector-aside__eyebrow">
            {status === 'paused'
              ? t('connectors.pausedEyebrow', { defaultValue: 'Paused' })
              : t('connectors.nextStep', { defaultValue: 'Next step' })}
          </p>
          <p>{row.line}</p>
          {status === 'error' && (
            <div className="v2-connector-aside__actions">
              <button type="button" className="v2-connector-aside__primary" disabled={busy} onClick={() => { void retry(item.entry); }}>
                {t('connectors.retry', { defaultValue: 'Retry' })}
              </button>
              {renderRemove(item)}
            </div>
          )}
          {row.action === 'cancel' && (
            <div className="v2-connector-aside__actions">
              <button type="button" className="v2-connector-aside__secondary" disabled={busy} onClick={() => { void runAction(item, 'cancel'); }}>
                {t('connectors.cancel', { defaultValue: 'Cancel' })}
              </button>
            </div>
          )}
          {row.action === 'retry-remove' && (
            <div className="v2-connector-aside__actions">
              <button type="button" className="v2-connector-aside__secondary" disabled={busy} onClick={() => { void runAction(item, 'retry-remove'); }}>
                {t('connectors.retryRemove', { defaultValue: 'Retry remove' })}
              </button>
            </div>
          )}
          {status === 'active' && row.action === 'retry' && (
            <div className="v2-connector-aside__actions">
              <button type="button" className="v2-connector-aside__primary" disabled={busy} onClick={() => { void retry(item.entry); }}>
                {t('connectors.retry', { defaultValue: 'Retry' })}
              </button>
              {renderRemove(item)}
            </div>
          )}
          {status === 'paused' && (
            <p className="v2-connector-aside__note">
              {t('connectors.pausedNote', { defaultValue: 'Only an administrator can resume it. Your relay, mode and pods are kept.' })}
            </p>
          )}
        </section>
      </aside>
    );
  };

  const renderAside = (item: ListItem) => {
    const row = rowForItem(item);
    if (item.kind === 'catalog') {
      const status = item.entry.installation?.status;
      if (!item.entry.available || !item.entry.installation) return null;
      if (status !== 'active' || !item.connector || row.action === 'retry') return renderParentAside(item, row);
    }
    const connector = item.connector as Connector;
    const isTelegram = connector.type === 'telegram';
    const isSlack = connector.type === 'slack';
    const connected = connector.status === 'connected';
    const supportsRelayControls = isTelegram || isSlack;
    const mirror = connector.config?.relayAllAgentMessages === true;
    const pendingBind = connector.config?.pendingBind;
    const activePod = podList.find((pod) => pod._id === connectorPodId(connector));
    const availableLeads = botMembers(activePod);
    const candidateSlackLead = slackLeadChoices[connector._id]
      ?? connector.config?.gates?.[String(connectorPodId(connector))]?.lead ?? '';
    const selectedSlackLead = availableLeads.some((bot) => bot.username === candidateSlackLead)
      ? candidateSlackLead : '';
    const userScoped = connector.scope === 'user' || Boolean(connector.config?.gates);
    const busy = busyFor(item);

    return (
      <aside className="v2-connectors__aside" aria-label={t('connectors.channelDetails', { defaultValue: 'Channel details' })}>
        {!connected && (
          <section className="v2-connector-aside__step">
            <p className="v2-connector-aside__eyebrow">{t('connectors.nextStep', { defaultValue: 'Next step' })}</p>
            {isTelegram && codeIsLive(connector) && (
              <>
                <p>
                  {t('connectors.enableHint', { defaultValue: 'Open a private chat with the Commonly bot' })}
                  {BOT_HANDLE ? ` (@${BOT_HANDLE.replace(/^@/, '')})` : ''}
                  {t('connectors.enableHintSend', { defaultValue: ' and send:' })}
                </p>
                <div className="v2-connector-code">
                  <code>{t('connectors.enableCommand', { defaultValue: '/commonly-enable {{code}}', code: groupCode(connector.config?.connectCode || '') })}</code>
                  <button type="button" className="v2-connector-code__copy" onClick={() => copyCommand(connector.config?.connectCode || '')}>
                    {copied === connector.config?.connectCode
                      ? t('connectors.copied', { defaultValue: 'Copied' })
                      : t('connectors.copyCommand', { defaultValue: 'Copy command' })}
                  </button>
                </div>
              </>
            )}
            {isTelegram && connector.status !== 'error' && !codeIsLive(connector) && (
              <>
                <p>{row.line}</p>
                <button type="button" className="v2-connector-aside__primary" disabled={busy} onClick={() => { void regenerateCode(connector); }}>
                  {t('connectors.newCode', { defaultValue: 'New code' })}
                </button>
              </>
            )}
            {isSlack && pendingBind && (
              <>
                <p>{t('connectors.slackConfirmHint', {
                  defaultValue: '{{workspace}} wants to connect as {{user}}.',
                  workspace: pendingBind.teamName || t('connectors.thisSlackWorkspace', { defaultValue: 'This Slack workspace' }),
                  user: pendingBind.slackUserName ? `@${pendingBind.slackUserName}` : t('connectors.yourSlackUser', { defaultValue: 'your Slack user' }),
                })}</p>
                <label htmlFor={`slack-lead-${connector._id}`}>
                  {t('connectors.slackBindLead', { defaultValue: 'Agent for plain messages' })}
                </label>
                <select
                  id={`slack-lead-${connector._id}`}
                  className="v2-connectors__select"
                  value={selectedSlackLead}
                  disabled={busy || pods === null || availableLeads.length === 0}
                  onChange={(event) => setSlackLeadChoices((current) => ({ ...current, [connector._id]: event.target.value }))}
                >
                  <option value="">{t('connectors.slackBindLeadNone', { defaultValue: 'Choose an agent' })}</option>
                  {availableLeads.map((bot) => <option key={bot.username} value={bot.username}>{bot.username}</option>)}
                </select>
                {pods !== null && availableLeads.length === 0 && (
                  <p>{t('connectors.slackNoAgent', { defaultValue: 'No agent is in this pod yet. Messages will reach the pod; choose a lead later.' })}</p>
                )}
                <div className="v2-connector-aside__actions">
                  <button type="button" className="v2-connector-aside__primary" disabled={busy || pods === null || (availableLeads.length > 0 && !selectedSlackLead)} onClick={() => { void resolveSlackBind(connector, 'confirm', item.key, selectedSlackLead); }}>
                    {t('connectors.slackConfirmConnection', { defaultValue: 'Confirm connection' })}
                  </button>
                  <button type="button" className="v2-connector-aside__secondary" disabled={busy} onClick={() => { void resolveSlackBind(connector, 'reject', item.key); }}>
                    {t('connectors.slackReject', { defaultValue: 'This is not me' })}
                  </button>
                </div>
              </>
            )}
            {isSlack && !pendingBind && connector.status !== 'error' && (
              <>
                <p>{row.line}</p>
                <button type="button" className="v2-connector-aside__primary" disabled={busy} onClick={() => { void authorizeSlack(connector, item.key); }}>
                  {t('connectors.slackAuthorize', { defaultValue: 'Authorize in Slack' })}
                </button>
              </>
            )}
            {/* Row C: one place for the aside's refusal, so it shows for the
                authorize verb and for a confirm/reject refusal alike. */}
            {isSlack && rowRefusal?.key === item.key && (
              <p className="v2-connector-aside__refusal" role="alert">{rowRefusal.message}</p>
            )}
            {connector.status === 'error' && (
              <>
                <p>{row.line}</p>
                {row.action && (
                  <button type="button" className="v2-connector-aside__primary" disabled={busy} onClick={() => { void runAction(item, row.action as ConnectorAction); }}>
                    {row.actionLabel}
                  </button>
                )}
              </>
            )}
          </section>
        )}

        {supportsRelayControls && (
          <section className="v2-connector-aside__card">
            <h2>{t('connectors.channelSees', { defaultValue: 'What the channel sees' })}</h2>
            <p>
              {connector.config?.liveRelay
                ? (mirror
                  ? t('connectors.mirrorHint', { defaultValue: 'Every agent message reaches the channel.' })
                  : t('connectors.attentionHint', { defaultValue: 'Only escalations and the lead agent reach the channel.' }))
                : t('connectors.relayOffHint', { defaultValue: 'Messages stay in the pod.' })}
            </p>
            {connected && (
              <div className="v2-connector-aside__controls">
                <label className="v2-connector-aside__relay">
                  <input
                    type="checkbox"
                    checked={Boolean(connector.config?.liveRelay)}
                    disabled={busy}
                    onChange={() => patchConfig(connector, { liveRelay: !connector.config?.liveRelay }, 'connectors.toggleError', 'Could not update live relay.')}
                  />
                  <span>{t('connectors.liveRelay', { defaultValue: 'Relay' })}</span>
                </label>
                {connector.config?.liveRelay && (
                  <div className="v2-connector-aside__mode" role="group" aria-label={t('connectors.mode', { defaultValue: 'Relay mode' })}>
                    <button
                      type="button"
                      className={!mirror ? 'v2-connector-aside__mode-opt v2-connector-aside__mode-opt--on' : 'v2-connector-aside__mode-opt'}
                      disabled={busy || !mirror}
                      onClick={() => patchConfig(connector, { relayAllAgentMessages: false }, 'connectors.modeError', 'Could not switch mode.')}
                    >
                      {t('connectors.modeAttention', { defaultValue: 'Attention' })}
                    </button>
                    <button
                      type="button"
                      className={mirror ? 'v2-connector-aside__mode-opt v2-connector-aside__mode-opt--on' : 'v2-connector-aside__mode-opt'}
                      disabled={busy || mirror}
                      onClick={() => patchConfig(connector, { relayAllAgentMessages: true }, 'connectors.modeError', 'Could not switch mode.')}
                    >
                      {t('connectors.modeMirror', { defaultValue: 'Mirror' })}
                    </button>
                  </div>
                )}
              </div>
            )}
            {connected && userScoped && renderGates(connector)}
            {renderRemove(item)}
          </section>
        )}
      </aside>
    );
  };

  return renderAside(panelItem);
};

export default ChannelPanel;
