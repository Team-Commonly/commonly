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

export type InspectorView =
  | { kind: 'overview' }
  | { kind: 'member'; agentKey: string }
  | { kind: 'artifact'; artifactId: string };

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
  const [inspectorView, setInspectorView] = useState<InspectorView>({ kind: 'overview' });
  const toggleInspector = useCallback(() => {
    setInspectorCollapsed((prev) => {
      const next = !prev;
      writeInspectorCollapsed(next);
      // Always reset to overview when re-opening, so the user lands in a
      // predictable place rather than the last sub-page.
      if (!next) setInspectorView({ kind: 'overview' });
      return next;
    });
  }, []);
  const openInspectorMember = useCallback((agentKey: string) => {
    if (!agentKey) return;
    setInspectorView({ kind: 'member', agentKey });
    setInspectorCollapsed(false);
    writeInspectorCollapsed(false);
  }, []);
  const openInspectorArtifact = useCallback((artifactId: string) => {
    if (!artifactId) return;
    setInspectorView({ kind: 'artifact', artifactId });
    setInspectorCollapsed(false);
    writeInspectorCollapsed(false);
  }, []);
  const resetInspectorView = useCallback(() => setInspectorView({ kind: 'overview' }), []);

  // When pod changes, drop any stale sub-page state.
  useEffect(() => {
    setInspectorView({ kind: 'overview' });
  }, [paramPodId]);

  // Auto-pick the first pod when the user lands on /v2 directly, so the
  // three-column layout doesn't render an empty main pane on first load.
  useEffect(() => {
    if (selectionMode !== 'auto' || paramPodId || loading) return;
    if (pods.length > 0) navigate(`/v2/pods/${pods[0]._id}`, { replace: true });
  }, [selectionMode, paramPodId, pods, loading, navigate]);

  const selectedPodId = paramPodId || null;
  const detail = useV2PodDetail(selectedPodId);

  // The inspector is a separate column only when expanded. When collapsed,
  // it's not rendered at all and the chat extends to the right edge — the
  // entry point is the avatar group in the chat header (see V2PodChat).
  const showInspector = Boolean(selectedPodId && !inspectorCollapsed);
  const shellClass = ['v2-shell', !showInspector ? 'v2-shell--no-inspector' : ''].filter(Boolean).join(' ');

  return (
    <div className={shellClass}>
      <V2NavRail />
      <V2PodsSidebar selectedPodId={selectedPodId} podsState={podsState} />
      <V2PodChat
        detail={detail}
        podsState={podsState}
        inspectorCollapsed={inspectorCollapsed}
        onToggleInspector={selectedPodId ? toggleInspector : undefined}
        onOpenMember={openInspectorMember}
        onOpenArtifact={openInspectorArtifact}
      />
      {selectedPodId && !inspectorCollapsed && (
        <V2PodInspector
          detail={detail}
          podsState={podsState}
          view={inspectorView}
          onClose={toggleInspector}
          onOpenMember={openInspectorMember}
          onOpenArtifact={openInspectorArtifact}
          onBack={resetInspectorView}
        />
      )}
    </div>
  );
};

export default V2Layout;
