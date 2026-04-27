import React, { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import V2NavRail from './V2NavRail';
import V2PodsSidebar from './V2PodsSidebar';
import V2PodChat from './V2PodChat';
import V2PodInspector from './V2PodInspector';
import { useV2Pods } from '../hooks/useV2Pods';
import { useV2PodDetail } from '../hooks/useV2PodDetail';

interface V2LayoutProps {
  selectionMode?: 'auto' | 'param';
}

const V2Layout: React.FC<V2LayoutProps> = ({ selectionMode = 'auto' }) => {
  const { podId: paramPodId } = useParams<{ podId: string }>();
  const navigate = useNavigate();
  const podsState = useV2Pods();
  const { pods, loading } = podsState;

  // Auto-pick the first pod when the user lands on /v2 directly, so the
  // three-column layout doesn't render an empty main pane on first load.
  useEffect(() => {
    if (selectionMode !== 'auto' || paramPodId || loading) return;
    if (pods.length > 0) navigate(`/v2/pods/${pods[0]._id}`, { replace: true });
  }, [selectionMode, paramPodId, pods, loading, navigate]);

  const selectedPodId = paramPodId || null;
  const detail = useV2PodDetail(selectedPodId);

  return (
    <div className={`v2-shell${selectedPodId ? '' : ' v2-shell--no-inspector'}`}>
      <V2NavRail />
      <V2PodsSidebar selectedPodId={selectedPodId} podsState={podsState} />
      <V2PodChat detail={detail} podsState={podsState} />
      {selectedPodId && <V2PodInspector detail={detail} podsState={podsState} />}
    </div>
  );
};

export default V2Layout;
