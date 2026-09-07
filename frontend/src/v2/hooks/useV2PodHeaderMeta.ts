import { useEffect, useState } from 'react';
import { useV2Api } from './useV2Api';

// The compact pod header (direction C) carries what the old inspector cards
// did: open board count and bound channels. Both are one read per pod; a
// failed read leaves the header without that fragment rather than blank.

interface TaskRow { status?: string }
interface ConnectorRow { type?: string; status?: string; podId?: { _id?: string } | string | null }

export interface V2PodHeaderMeta {
  boardOpen: number | null;
  channels: string[];
}

export const useV2PodHeaderMeta = (podId: string | null | undefined): V2PodHeaderMeta => {
  const api = useV2Api();
  const [boardOpen, setBoardOpen] = useState<number | null>(null);
  const [channels, setChannels] = useState<string[]>([]);

  useEffect(() => {
    if (!podId) {
      setBoardOpen(null);
      setChannels([]);
      return undefined;
    }
    let active = true;
    api.get<{ tasks?: TaskRow[] }>(`/api/v1/tasks/${encodeURIComponent(podId)}`)
      .then((data) => {
        if (!active) return;
        const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
        setBoardOpen(tasks.filter((task) => task.status === 'pending' || task.status === 'claimed' || task.status === 'in_progress').length);
      })
      .catch(() => { if (active) setBoardOpen(null); });
    api.get<ConnectorRow[]>('/api/integrations/user/all')
      .then((rows) => {
        if (!active) return;
        const bound = (Array.isArray(rows) ? rows : []).filter((row) => {
          const boundPodId = typeof row.podId === 'object' ? row.podId?._id : row.podId;
          return boundPodId === podId && row.status === 'connected' && row.type;
        });
        setChannels([...new Set(bound.map((row) => String(row.type)))]);
      })
      .catch(() => { if (active) setChannels([]); });
    return () => { active = false; };
  }, [api, podId]);

  return { boardOpen, channels };
};

export default useV2PodHeaderMeta;
