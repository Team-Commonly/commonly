// The paste-a-key form of an operator-key hosted entry (TASK-330). One key is
// bound to one agent; the server proves it against the vendor before the row
// goes connected. The key lives only in this form's state and is cleared once
// the request settles, whatever the answer, so it never outlives the submit.
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolCatalogEntry } from './toolModel';

export interface KeyAgent {
  userId: string;
  label: string;
}

export type OperatorKeyResult = { ok: true } | { ok: false; code: string };

interface Props {
  entry: ToolCatalogEntry;
  /** The agents a key can still be added for: the person's own, minus those already keyed here. */
  agents: KeyAgent[];
  submit: (entry: ToolCatalogEntry, agentId: string, key: string) => Promise<OperatorKeyResult>;
}

const OperatorKeyForm: React.FC<Props> = ({ entry, agents, submit }) => {
  const { t } = useTranslation();
  const [picked, setPicked] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // A keyed agent leaves the list after the refresh, so the pick falls back to
  // the first agent still offered rather than naming one that is gone.
  const agentId = agents.some((agent) => agent.userId === picked) ? picked : (agents[0]?.userId || '');

  // Fixed copy per route code: the server's own message is never shown, and no
  // sentence carries the key.
  const sentences: Record<string, () => string> = {
    invalid_agent: () => t('tools.operatorKey.errors.invalidAgent'),
    agent_not_owned: () => t('tools.operatorKey.errors.agentNotOwned'),
    unknown_entry: () => t('tools.operatorKey.errors.unknownEntry'),
    not_operator_key: () => t('tools.operatorKey.errors.unknownEntry'),
    key_missing: () => t('tools.operatorKey.errors.keyMissing'),
    scope_refused: () => t('tools.operatorKey.errors.scopeRefused'),
    vendor_rejected: () => t('tools.operatorKey.errors.vendorRejected', { label: entry.label }),
    vendor_unreachable: () => t('tools.operatorKey.errors.vendorUnreachable', { label: entry.label }),
    connection_changed: () => t('tools.operatorKey.errors.connectionChanged'),
    key_store_failed: () => t('tools.operatorKey.errors.keyStoreFailed'),
  };
  const sentenceFor = (code: string): string => (
    Object.prototype.hasOwnProperty.call(sentences, code)
      ? sentences[code]()
      : t('tools.operatorKey.errors.generic')
  );

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !agentId) return;
    if (!key.trim()) {
      setFailure(sentenceFor('key_missing'));
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const result = await submit(entry, agentId, key);
      if (result.ok === false) setFailure(sentenceFor(result.code));
    } finally {
      setKey('');
      setBusy(false);
    }
  };

  return (
    <form className="v2-tools__form v2-cx-keyform" onSubmit={(event) => { void onSubmit(event); }}>
      <label className="v2-tools__field">
        <span>{t('tools.operatorKey.agent')}</span>
        <select className="v2-connectors__select" value={agentId} disabled={busy} onChange={(event) => setPicked(event.target.value)}>
          {agents.map((agent) => <option key={agent.userId} value={agent.userId}>{agent.label}</option>)}
        </select>
      </label>
      <label className="v2-tools__field">
        <span>{t('tools.operatorKey.key')}</span>
        <input
          className="v2-tools__input"
          type="password"
          // A vendor key, not this site's password: "new-password" stops
          // browsers offering a saved login, and the data- attributes keep
          // 1Password and LastPass from offering to save it.
          autoComplete="new-password"
          data-1p-ignore
          data-lpignore="true"
          spellCheck={false}
          value={key}
          disabled={busy}
          onChange={(event) => setKey(event.target.value)}
        />
      </label>
      {failure && <p className="v2-cx-error" role="alert">{failure}</p>}
      <div className="v2-cx-pop__acts">
        <button type="submit" className="v2-connector-row__action" disabled={busy || !agentId}>
          {busy ? t('tools.operatorKey.checking') : t('tools.operatorKey.submit')}
        </button>
      </div>
    </form>
  );
};

export default OperatorKeyForm;
