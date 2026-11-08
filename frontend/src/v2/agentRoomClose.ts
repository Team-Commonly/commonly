// F307: closing a direct message pod (Pod.type 'agent-room'). The pod leaves
// the person's list and comes back when either side writes, on Talk to, or on
// Undo. Frame: docs/design/artboards/f303.
//
// The close happens in the thread or the inspector, and the Undo line shows in
// the pods list, so the last close is held here and announced with an event
// rather than threaded through props.
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useV2Api } from './hooks/useV2Api';

export const AGENT_ROOM_CLOSED_EVENT = 'v2:agent-room-closed';

export type ClosedRoom = { id: string; name: string };

let lastClosed: ClosedRoom | null = null;

export const lastClosedRoom = (): ClosedRoom | null => lastClosed;

export const setClosedRoom = (room: ClosedRoom | null): void => {
  lastClosed = room;
  window.dispatchEvent(new CustomEvent(AGENT_ROOM_CLOSED_EVENT, { detail: room }));
};

/** Close the pod, refresh the list, then go to the pods list where Undo shows. */
export const useCloseAgentRoom = (onListChanged?: () => unknown) => {
  const api = useV2Api();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const close = useCallback(async (room: ClosedRoom) => {
    setBusy(true);
    setFailed(false);
    try {
      await api.post(`/api/pods/${encodeURIComponent(room.id)}/close`, {});
      setClosedRoom(room);
      await onListChanged?.();
      navigate('/v2');
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, [api, navigate, onListChanged]);
  return { close, busy, failed };
};
