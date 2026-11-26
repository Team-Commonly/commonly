// F669: how many turns the owner's own agent ran today and in the last 7 days, each one
// on the owner's Claude or Codex account. The server answers only the agent's
// owner (GET /api/registry/agents/:name/turns); anyone else gets a 404, and
// this renders nothing for them.
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import axios from '../../utils/axiosConfig';

interface PodTurns {
  podId: string;
  podName: string;
  podType?: string;
  today: number;
  week: number;
}

interface TurnCounts {
  timeZone: string;
  today: number;
  week: number;
  /** The server kept fewer turns than ran in the 7 days, so `week` is a floor. */
  weekCapped?: boolean;
  pods: PodTurns[];
  elsewhere: { today: number; week: number };
}

const V2AgentTurnCount: React.FC<{
  agentName: string;
  instanceId: string;
  /** Where the owner sets what the agent wakes on. */
  changeHref: string;
}> = ({ agentName, instanceId, changeHref }) => {
  const { t } = useTranslation();
  const [counts, setCounts] = useState<TurnCounts | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let active = true;
    setCounts(null);
    setOpen(false);
    axios.get<TurnCounts>(`/api/registry/agents/${encodeURIComponent(agentName)}/turns`, { params: { instanceId } })
      .then((response) => {
        if (active && response?.data && Number.isFinite(response.data.today)) setCounts(response.data);
      })
      .catch(() => { /* not the owner, or not run on a computer: nothing to show */ });
    return () => { active = false; };
  }, [agentName, instanceId]);

  if (!counts) return null;
  const listId = `agent-turns-${agentName}-${instanceId}`;
  const rows = [
    ...counts.pods.map((pod) => ({
      key: pod.podId,
      name: pod.podType === 'agent-room' ? t('agentSettings.yourDirectMessage') : pod.podName,
      today: pod.today,
      week: pod.week,
    })),
    ...(counts.elsewhere.week > 0
      ? [{ key: 'elsewhere', name: t('agentSettings.turnsElsewhere'), ...counts.elsewhere }] : []),
  ];

  return (
    <div className="v2-agent-turns" data-testid="agent-turns">
      <div className="v2-agent-turns__head">
        <span className="v2-agent-turns__line" title={t('agentSettings.turnsHint')}>
          {t('agentSettings.turnsLine', { count: counts.today, week: counts.weekCapped ? `${counts.week}+` : counts.week })}
        </span>
        {rows.length > 0 && (
          <button type="button" className="b b-g ib b-sm v2-agent-turns__toggle" aria-expanded={open} aria-controls={listId}
            aria-label={t('agentSettings.turnsByPod')} title={t('agentSettings.turnsByPod')}
            onClick={() => setOpen((value) => !value)}>
            <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
          </button>
        )}
        <a className="v2-agent-turns__change" href={changeHref} aria-label={t('agentSettings.turnsChangeLabel')}>
          {t('agentSettings.turnsChange')}
        </a>
      </div>
      {rows.length > 0 && (
        <ul id={listId} className="v2-agent-turns__pods" hidden={!open}>
          {rows.map((row) => (
            <li key={row.key} data-testid="agent-turns-pod">
              <span className="v2-agent-turns__pod">{row.name}</span>
              <span className="v2-agent-turns__count">
                {t('agentSettings.turnsPodCounts', { today: row.today, week: row.week })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default V2AgentTurnCount;
