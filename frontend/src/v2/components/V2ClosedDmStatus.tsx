// F307: after a person closes a direct message, the pods list says so once,
// with Undo. It stays until they open another pod, so a slow reader still gets it.
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useV2Api } from '../hooks/useV2Api';
import {
  AGENT_ROOM_CLOSED_EVENT, ClosedRoom, lastClosedRoom, setClosedRoom,
} from '../agentRoomClose';
import './V2CloseDm.css';

const V2ClosedDmStatus: React.FC<{
  selectedPodId: string | null;
  onListChanged?: () => unknown;
  /** The phone's pods page unmounts when a pod opens, so leaving it is the end. */
  clearOnLeave?: boolean;
}> = ({ selectedPodId, onListChanged, clearOnLeave = false }) => {
  const { t } = useTranslation();
  const api = useV2Api();
  const navigate = useNavigate();
  const [room, setRoom] = useState<ClosedRoom | null>(() => lastClosedRoom());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onClosed = (event: Event) => setRoom((event as CustomEvent<ClosedRoom | null>).detail || null);
    window.addEventListener(AGENT_ROOM_CLOSED_EVENT, onClosed);
    return () => window.removeEventListener(AGENT_ROOM_CLOSED_EVENT, onClosed);
  }, []);

  // The close lands somewhere: the pods list on a phone, or the shell's
  // default pod on a wide screen. That landing is part of the close. Opening
  // any other pod after it ends the moment the line was about.
  const landing = useRef<{ roomId: string; podId: string | null } | null>(null);
  useEffect(() => {
    if (!room) { landing.current = null; return; }
    // The close is announced while its own pod is still selected; that isn't a landing.
    const here = selectedPodId === room.id ? null : selectedPodId;
    if (!landing.current || landing.current.roomId !== room.id) {
      landing.current = { roomId: room.id, podId: here };
      return;
    }
    if (!landing.current.podId) landing.current.podId = here;
    else if (here && here !== landing.current.podId) setClosedRoom(null);
  }, [room, selectedPodId]);

  useEffect(() => () => {
    if (clearOnLeave && lastClosedRoom()) setClosedRoom(null);
  }, [clearOnLeave]);

  if (!room) return null;

  const undo = async () => {
    setBusy(true);
    try {
      await api.post(`/api/pods/${encodeURIComponent(room.id)}/reopen`, {});
      await onListChanged?.();
      setClosedRoom(null);
      navigate(`/v2/pods/${encodeURIComponent(room.id)}`);
    } catch {
      // The line stays, so Undo can be pressed again.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="v2-closed-dm-status" role="status" data-testid="closed-dm-status">
      <span>{t('podChat.closeDm.closed', { name: room.name })}</span>
      <button type="button" className="v2-close-dm-link" disabled={busy} onClick={() => { void undo(); }}>
        {t('podChat.closeDm.undo')}
      </button>
    </div>
  );
};

export default V2ClosedDmStatus;
