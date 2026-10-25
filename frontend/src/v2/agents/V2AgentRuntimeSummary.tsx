import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { describeRuntime, Runtime } from '../components/V2AgentRuntimeGrants';

export const agentRuntimeKind = (runtime: Runtime, connected: boolean | null) => {
  const details = describeRuntime(runtime);
  if (details.mode === 'native') return 'builtIn';
  if (details.mode === 'hosted') return 'hosted';
  return connected === false && !runtime.observation?.lastSpawn ? 'notConnected' : 'byo';
};

const V2AgentRuntimeSummary: React.FC<{
  name: string; runtime: Runtime; serverModel?: string | null;
}> = ({ name, runtime, serverModel }) => {
  const { t } = useTranslation();
  const [copyError, setCopyError] = useState(false);
  const details = describeRuntime(runtime);
  const onCommonly = details.mode === 'native' || details.mode === 'hosted';
  const last = runtime.observation?.lastSpawn;
  const observedHarness = last ? describeRuntime({ ...runtime, adapter: last.harness }).adapter || last.harness : null;
  const model = onCommonly ? serverModel : last?.model;
  const configCommand = `commonly agent config ${name} --model <id> --effort <level>`;
  const copy = async () => {
    setCopyError(false);
    try { await navigator.clipboard.writeText(configCommand); }
    catch { setCopyError(true); }
  };
  return <div className="v2-agent-runtime-summary">
    <dl>
      <div><dt>{t('agentSettings.rev3.where')}</dt><dd>{t(`agentSettings.rev3.${details.mode === 'native' ? 'builtInLocation' : onCommonly ? 'onCommonly' : last ? 'onMachine' : 'onceConnected'}`)}
        {observedHarness ? ` · ${observedHarness}` : ''}</dd></div>
      <div><dt>{t(`agentSettings.rev3.${onCommonly ? 'model' : 'modelEffort'}`)}</dt>
        <dd>{onCommonly && t('agentSettings.rev3.modelPrefix')}{model || t('agentManage.controls.notReported')}
          {!onCommonly && last?.effort ? ` · ${last.effort}` : ''}
          {(onCommonly || last) && <small>{t(`agentSettings.rev3.${onCommonly ? 'serverReported' : 'machineReported'}`)}</small>}
        </dd></div>
    </dl>
    {!onCommonly && last && <div className="v2-agent-runtime-summary__command"><code>{configCommand.split(' ').map((word, index) => <React.Fragment key={index}>{index > 0 && ' '}<span>{word}</span></React.Fragment>)}</code>
      <button type="button" onClick={() => { void copy(); }}>{t('common.copy')}</button>
    </div>}
    {copyError && <p role="alert">{t('agentSettings.rev3.copyError')}</p>}
  </div>;
};

export default V2AgentRuntimeSummary;
