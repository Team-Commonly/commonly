import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import V2NavRail from './V2NavRail';
import V2PodsSidebar from './V2PodsSidebar';
import V2Thread from './V2Thread';
import V2Inspector from './V2Inspector';
import V2InviteModal, { type V2InviteTab } from './V2InviteModal';
import V2FirstRunHero from './V2FirstRunHero';
import { useV2Pods } from '../hooks/useV2Pods';
import { useV2PodDetail } from '../hooks/useV2PodDetail';
import { getSignedAttachmentUrl } from '../../utils/signedAttachmentUrl';
import { useAuth } from '../../context/AuthContext';

interface V2LayoutProps {
  selectionMode?: 'auto' | 'param';
}

const INSPECTOR_PREF_KEY = 'v2.inspectorCollapsed';
const LAST_POD_KEY = 'v2:lastPodId';
const INVITE_BLOCKED_POD_TYPES = new Set(['agent-room', 'agent-dm']);

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

const readLastPodId = (): string | null => {
  try {
    return localStorage.getItem(LAST_POD_KEY);
  } catch {
    return null;
  }
};

const writeLastPodId = (podId: string) => {
  try {
    localStorage.setItem(LAST_POD_KEY, podId);
  } catch {
    // localStorage unavailable; auto-selection falls back to the workspace.
  }
};

const createdAtTime = (createdAt?: string): number => {
  if (!createdAt) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(createdAt);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
};

const V2Layout: React.FC<V2LayoutProps> = ({ selectionMode = 'auto' }) => {
  const { t } = useTranslation();
  const { podId: paramPodId } = useParams<{ podId: string }>();
  const navigate = useNavigate();
  const { currentUser } = useAuth();
  const podsState = useV2Pods();
  const { pods, loading } = podsState;

  const [inspectorCollapsed, setInspectorCollapsed] = useState<boolean>(readInspectorCollapsed());
  // Invite modal lives here (not in V2Inspector) so the chat header
  // invite icon and the inspector "+ Invite" button can both open it. The
  // modal itself is V2InviteModal — this component just owns open/close.
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteInitialTab, setInviteInitialTab] = useState<V2InviteTab>('people');
  const openInvite = useCallback((initialTab: V2InviteTab = 'people') => {
    setInviteInitialTab(initialTab);
    setInviteOpen(true);
  }, []);
  const closeInvite = useCallback(() => setInviteOpen(false), []);
  // Mobile (<=760px) pods drawer. The sidebar is a fixed slide-over on phones
  // instead of a grid column; this owns its open/closed state. Desktop ignores
  // it entirely (the sidebar is always a visible column there).
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // Assume visible until the ownership-status probe resolves. This prevents
  // the empty-state stack from flashing while the shell-level first-run modal
  // decides whether it should open; an established/dismissed user flips it off
  // as soon as the probe resolves.
  const [firstRunVisible, setFirstRunVisible] = useState(true);
  const openMobileNav = useCallback(() => setMobileNavOpen(true), []);
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);
  const toggleInspector = useCallback(() => {
    setInspectorCollapsed((prev) => {
      const next = !prev;
      writeInspectorCollapsed(next);
      return next;
    });
  }, []);
  const openInspector = useCallback(() => {
    setInspectorCollapsed(false);
    writeInspectorCollapsed(false);
  }, []);
  // File pills stay useful without an artifact sub-page in the compact
  // inspector: mint the same authorized ObjectStore URL and open it directly.
  const openFile = useCallback((fileName: string) => {
    if (!fileName) return;
    void getSignedAttachmentUrl(`/api/uploads/${fileName}`).then((signed) => {
      if (signed) window.open(signed, '_blank', 'noopener,noreferrer');
    });
  }, []);

  // Close the mobile drawer when navigation came from somewhere other than a
  // drawer tap.
  useEffect(() => {
    setMobileNavOpen(false);
    if (paramPodId) writeLastPodId(paramPodId);
  }, [paramPodId]);

  // Resume the last valid room. A new user without history lands in their
  // self-created invite-only workspace rather than the auto-joined HQ.
  useEffect(() => {
    if (selectionMode !== 'auto' || paramPodId || loading) return;
    if (pods.length === 0) return;

    const lastPodId = readLastPodId();
    const lastPod = lastPodId ? pods.find((pod) => pod._id === lastPodId) : undefined;
    const ownWorkspace = pods
      .filter((pod) => (
        pod.createdBy?._id === currentUser?._id
        && pod.joinPolicy === 'invite-only'
      ))
      .sort((left, right) => createdAtTime(left.createdAt) - createdAtTime(right.createdAt))[0];
    const destination = lastPod || ownWorkspace || pods[0];

    navigate(`/v2/pods/${destination._id}`, { replace: true });
  }, [selectionMode, paramPodId, pods, loading, navigate, currentUser?._id]);

  const selectedPodId = paramPodId || null;
  const detail = useV2PodDetail(selectedPodId);
  // Agent-room creation happens outside this pod-list hook. After navigation,
  // refresh the membership list once if that newly selected room is not in it
  // yet, so it immediately appears in both All and DMs instead of waiting for
  // a later full-shell refresh.
  const refreshedMissingPodRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedPodId || loading || pods.some((pod) => pod._id === selectedPodId)) {
      if (pods.some((pod) => pod._id === selectedPodId)) refreshedMissingPodRef.current = null;
      return;
    }
    if (refreshedMissingPodRef.current === selectedPodId) return;
    refreshedMissingPodRef.current = selectedPodId;
    void podsState.refresh();
  }, [selectedPodId, pods, loading, podsState]);
  // Personal DMs are strictly 1:1. Keep agent-admin out of this set: it is
  // intentionally N:1 and remains invitable (ADR-001 §3.10).
  const inviteEnabled = Boolean(
    selectedPodId
    && detail.pod
    && !INVITE_BLOCKED_POD_TYPES.has(String(detail.pod.type)),
  );

  // The inspector is a separate column only when expanded. When collapsed,
  // it's not rendered at all and the chat extends to the right edge — the
  // entry point is the working-count control in the thread header (see V2Thread).
  const showInspector = Boolean(selectedPodId && !inspectorCollapsed);
  const shellClass = ['v2-shell', !showInspector ? 'v2-shell--no-inspector' : ''].filter(Boolean).join(' ');

  return (
    <div className={shellClass}>
      <V2NavRail onPodsMobileNav={openMobileNav} />
      {mobileNavOpen && (
        <button
          type="button"
          className="v2-mobile-backdrop"
          aria-label={t('common.closePodsList')}
          onClick={closeMobileNav}
        />
      )}
      <V2PodsSidebar
        selectedPodId={selectedPodId}
        podsState={podsState}
        mobileOpen={mobileNavOpen}
        onMobileClose={closeMobileNav}
      />
      <V2Thread
        detail={detail}
        podsState={podsState}
        firstRunVisible={firstRunVisible}
        inspectorCollapsed={inspectorCollapsed}
        onToggleInspector={selectedPodId ? toggleInspector : undefined}
        onOpenMember={openInspector}
        onOpenInvite={inviteEnabled ? openInvite : undefined}
        onOpenFile={openFile}
        onOpenMobileNav={openMobileNav}
      />
      {selectedPodId && !inspectorCollapsed && (
        <>
          <button
            type="button"
            className="v2-inspector-backdrop"
            aria-label="Close inspector"
            onClick={toggleInspector}
          />
          <V2Inspector
            detail={detail}
            onClose={toggleInspector}
            onOpenInvite={inviteEnabled ? () => openInvite() : undefined}
          />
        </>
      )}
      <V2FirstRunHero onVisibilityChange={setFirstRunVisible} />
      {inviteEnabled && detail.pod && (
        <V2InviteModal
          open={inviteOpen}
          podId={detail.pod._id}
          podName={detail.pod.name || 'pod'}
          initialTab={inviteInitialTab}
          onClose={closeInvite}
        />
      )}
    </div>
  );
};

export default V2Layout;
