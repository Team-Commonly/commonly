import React, { useEffect, useState, useCallback } from 'react';
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

const INSPECTOR_PREF_KEY = 'v2.inspectorCollapsed';

const readInspectorCollapsed = (): boolean => {
  try {
    const v = localStorage.getItem(INSPECTOR_PREF_KEY);
    // Default to collapsed — pod chat reads better when the third column is
    // out of the way until you ask for it. See user feedback 2026-04-30.
    if (v === null) return true;
    return v === '1';
  } catch {
    return true;
  }
};

const writeInspectorCollapsed = (next: boolean) => {
  try {
    localStorage.setItem(INSPECTOR_PREF_KEY, next ? '1' : '0');
  } catch {
    // localStorage unavailable; revert to default on next render.
  }
};

const V2Layout: React.FC<V2LayoutProps> = ({ selectionMode = 'auto' }) => {
  const { podId: paramPodId } = useParams<{ podId: string }>();
  const navigate = useNavigate();
  const podsState = useV2Pods();
  const { pods, loading } = podsState;

  const [inspectorCollapsed, setInspectorCollapsed] = useState<boolean>(readInspectorCollapsed());
  const toggleInspector = useCallback(() => {
    setInspectorCollapsed((prev) => {
      const next = !prev;
      writeInspectorCollapsed(next);
      return next;
    });
  }, []);

  // Auto-pick the first pod when the user lands on /v2 directly, so the
  // three-column layout doesn't render an empty main pane on first load.
  useEffect(() => {
    if (selectionMode !== 'auto' || paramPodId || loading) return;
    if (pods.length > 0) navigate(`/v2/pods/${pods[0]._id}`, { replace: true });
  }, [selectionMode, paramPodId, pods, loading, navigate]);

  const selectedPodId = paramPodId || null;
  const detail = useV2PodDetail(selectedPodId);

  const shellClass = [
    'v2-shell',
    selectedPodId ? '' : 'v2-shell--no-inspector',
    selectedPodId && inspectorCollapsed ? 'v2-shell--inspector-collapsed' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={shellClass}>
      <V2NavRail />
      <V2PodsSidebar selectedPodId={selectedPodId} podsState={podsState} />
      <V2PodChat detail={detail} podsState={podsState} />
      {selectedPodId && (
        <V2PodInspector
          detail={detail}
          podsState={podsState}
          collapsed={inspectorCollapsed}
          onToggle={toggleInspector}
        />
      )}
    </div>
  );
};

export default V2Layout;
