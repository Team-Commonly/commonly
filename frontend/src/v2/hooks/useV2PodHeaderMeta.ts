import { useCallback, useEffect, useRef, useState } from 'react';
import { useV2Api } from './useV2Api';
import { useSocket } from '../../context/SocketContext';

// The compact pod header (direction C) carries what the old inspector cards
// did: open board count and bound channels. Both are one read per pod; a
// failed read leaves the header without that fragment rather than blank.
// The open count then follows the board's own live wire: a task_updated for
// this pod re-reads it, and so does a reconnect that may have missed one.
// The same read carries the two starter tasks sign-up seeds (D288): the
// first-run bar shows their state and stands in for the count until both
// are done.

interface TaskRow { status?: string; sourceRef?: string }
interface ConnectorRow { type?: string; status?: string; podId?: { _id?: string } | string | null }

// Done flags for the seeded starter tasks; null when the pod has neither.
export interface V2StarterSteps { connect: boolean; firstTask: boolean }

const CONNECT_AGENT_REF = 'onboarding:connect-agent';
const FIRST_TASK_REF = 'onboarding:first-task';

export const starterStepsFrom = (tasks: TaskRow[]): V2StarterSteps | null => {
  const connect = tasks.find((task) => task.sourceRef === CONNECT_AGENT_REF);
  const firstTask = tasks.find((task) => task.sourceRef === FIRST_TASK_REF);
  if (!connect && !firstTask) return null;
  // A missing row counts as done: the bar never asks for a step it can't track.
  return { connect: !connect || connect.status === 'done', firstTask: !firstTask || firstTask.status === 'done' };
};

export interface V2PodHeaderMeta {
  boardOpen: number | null;
  channels: string[];
  starter: V2StarterSteps | null;
}

export const useV2PodHeaderMeta = (podId: string | null | undefined): V2PodHeaderMeta => {
  const api = useV2Api();
  const { socket } = useSocket();
  const [boardOpen, setBoardOpen] = useState<number | null>(null);
  const [channels, setChannels] = useState<string[]>([]);
  const [starter, setStarter] = useState<V2StarterSteps | null>(null);
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
        setStarter(starterStepsFrom(tasks));
      })
      .catch(() => {
        if (boardReadRef.current !== read) return;
        setBoardOpen(null);
        setStarter(null);
      });
  }, [api]);

  useEffect(() => {
    setStarter(null);
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

  return { boardOpen, channels, starter };
};
