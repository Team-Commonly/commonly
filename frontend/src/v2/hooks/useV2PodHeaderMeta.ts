import { useCallback, useEffect, useRef, useState } from 'react';
import { useV2Api } from './useV2Api';
import { useSocket } from '../../context/SocketContext';

// The compact pod header (direction C) carries what the old inspector cards
// did: open board count and bound channels. Both are one read per pod; a
// failed read leaves the header without that fragment rather than blank.
// The open count then follows the board's own live wire: a task_updated for
// this pod re-reads it, and so does a reconnect that may have missed one.

interface TaskRow { status?: string }
interface ConnectorRow { type?: string; status?: string; podId?: { _id?: string } | string | null }

export interface V2PodHeaderMeta {
  boardOpen: number | null;
  channels: string[];
}

export const useV2PodHeaderMeta = (podId: string | null | undefined): V2PodHeaderMeta => {
  const api = useV2Api();
  const { socket } = useSocket();
  const [boardOpen, setBoardOpen] = useState<number | null>(null);
  const [channels, setChannels] = useState<string[]>([]);
  // A slower earlier read must not overwrite a newer one, and a read started
  // for a pod we have since left must not land on the next pod's header.
  const boardReadRef = useRef(0);

  const loadBoardOpen = useCallback((id: string) => {
    boardReadRef.current += 1;
    const read = boardReadRef.current;
    api.get<{ tasks?: TaskRow[] }>(`/api/v1/tasks/${encodeURIComponent(id)}`)
      .then((data) => {
        if (boardReadRef.current !== read) return;
        const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
        setBoardOpen(tasks.filter((task) => task.status === 'pending' || task.status === 'claimed' || task.status === 'in_progress').length);
      })
      .catch(() => { if (boardReadRef.current === read) setBoardOpen(null); });
  }, [api]);

  useEffect(() => {
    if (!podId) {
      setBoardOpen(null);
      setChannels([]);
      return undefined;
    }
    let active = true;
    loadBoardOpen(podId);
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
    return () => {
      active = false;
      boardReadRef.current += 1;
    };
  }, [api, podId, loadBoardOpen]);

  useEffect(() => {
    if (!podId || !socket) return undefined;
    const onTaskUpdated = (payload: { podId?: string } | null) => {
      if (!payload || (payload.podId && payload.podId !== podId)) return;
      loadBoardOpen(podId);
    };
    const onConnect = () => { loadBoardOpen(podId); };
    socket.on('task_updated', onTaskUpdated);
    socket.on('connect', onConnect);
    return () => {
      socket.off('task_updated', onTaskUpdated);
      socket.off('connect', onConnect);
    };
  }, [podId, socket, loadBoardOpen]);

  return { boardOpen, channels };
};

export default useV2PodHeaderMeta;
