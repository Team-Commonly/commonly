import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import axios from '../../utils/axiosConfig';
import { roomRefusal } from '../utils/roomRefusal';

// Opens (or reuses) the 1:1 room with an agent and navigates to it. The same
// idempotent room endpoint the profile and Your Team entry points call.
export const useTalkToAgent = (agentName: string, instanceId: string) => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const talkTo = useCallback(async () => {
    setOpening(true);
    setFailed(null);
    try {
      const res = await axios.post<{ room?: { _id?: string } }>('/api/agents/runtime/room', { agentName, instanceId: instanceId || 'default' });
      const roomId = res.data?.room?._id;
      if (!roomId) throw new Error('Agent room not returned');
      navigate(`/v2/pods/${roomId}`);
    } catch (error) {
      setFailed(roomRefusal(error, t) || t('agentProfile.hero.openRoomFailed'));
      setOpening(false);
    }
  }, [agentName, instanceId, navigate, t]);
  return { talkTo, opening, failed };
};
