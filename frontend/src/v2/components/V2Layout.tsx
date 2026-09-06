import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import V2NavRail from './V2NavRail';
import V2PodsSidebar from './V2PodsSidebar';
import V2Thread from './V2Thread';
import V2Inspector from './V2Inspector';
import V2InviteModal, { type V2InviteTab } from './V2InviteModal';
import V2FirstRunHero from './V2FirstRunHero';
import V2MobileTabs from './V2MobileTabs';
import { useV2Pods } from '../hooks/useV2Pods';
import { useV2PodDetail } from '../hooks/useV2PodDetail';
import { useV2PodAttention } from '../hooks/useV2PodAttention';
import { getSignedAttachmentUrl } from '../../utils/signedAttachmentUrl';
import { useAuth } from '../../context/AuthContext';
import { recordPodVisit } from '../lib/podRecency';

interface V2LayoutProps {
  selectionMode?: 'auto' | 'param';
}

const INSPECTOR_PREF_KEY = 'v2.inspectorCollapsed';
const LAST_POD_KEY = 'v2:lastPodId';
const INVITE_BLOCKED_POD_TYPES = new Set(['agent-room', 'agent-dm']);
const PHONE_MEDIA_QUERY = '(max-width: 760px)';

const isPhoneViewport = (): boolean => (
  typeof window !== 'undefined' && !!window.matchMedia?.(PHONE_MEDIA_QUERY).matches
);

const readInspectorCollapsed = (): boolean => {
  try {
    const v = localStorage.getItem(INSPECTOR_PREF_KEY);
    if (v !== null) return v === '1';
  } catch {
    // Unavailable storage uses the same default as a fresh session.
  }
  // The artboard opens the desktop inspector by default; narrower viewports
  // keep it closed until requested. Explicit preferences take precedence.
  return !(typeof window !== 'undefined' && window.matchMedia?.('(min-width: 1200px)').matches);
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
  const { podId: paramPodId } = useParams<{ podId: string }>();
  const navigate = useNavigate();
  const { currentUser } = useAuth();
  const podsState = useV2Pods();
  const { pods, loading } = podsState;
  const attention = useV2PodAttention();

  // Direction C on the phone: the pods list is a page and a pod is the next
  // page. There is no drawer. `phone` tracks the viewport so `/v2` renders the
  // list instead of redirecting into the last pod.
  const [phone, setPhone] = useState<boolean>(() => isPhoneViewport());
  // A desktop preference must not leak into the phone sheet. This initializer
  // prevents its first rendered frame from flashing open; the media listener
  // below handles later viewport changes. On phones the sheet opens only
  // through the header or bottom control.
  const [inspectorCollapsed, setInspectorCollapsed] = useState<boolean>(() => (
    isPhoneViewport() ? true : readInspectorCollapsed()
  ));
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
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const phoneViewport = window.matchMedia(PHONE_MEDIA_QUERY);
    const onChange = () => {
      setPhone(phoneViewport.matches);
      if (phoneViewport.matches) setInspectorCollapsed(true);
    };
    onChange();
    phoneViewport.addEventListener('change', onChange);
    return () => phoneViewport.removeEventListener('change', onChange);
  }, []);
  // Assume visible until the ownership-status probe resolves. This prevents
  // the empty-state stack from flashing while the shell-level first-run modal
  // decides whether it should open; an established/dismissed user flips it off
  // as soon as the probe resolves.
  const [firstRunVisible, setFirstRunVisible] = useState(true);
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
  // Back from a pod on the phone returns to the list page.
  const backToPods = useCallback(() => navigate('/v2'), [navigate]);

  // Every opened pod is remembered twice: the last one for the next automatic
  // desktop selection, and the visit log that orders the sidebar's Recent.
  useEffect(() => {
    if (!paramPodId) return;
    writeLastPodId(paramPodId);
    recordPodVisit(paramPodId);
  }, [paramPodId]);

  // Desktop only: resume the last valid pod. A new user without history lands
  // in their self-created invite-only workspace rather than the auto-joined HQ.
  // The phone never redirects: `/v2` is the pods list page there.
  useEffect(() => {
    if (selectionMode !== 'auto' || paramPodId || loading || phone) return;
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
  }, [selectionMode, paramPodId, pods, loading, navigate, currentUser?._id, phone]);

  const selectedPodId = paramPodId || null;
  const detail = useV2PodDetail(selectedPodId);
  // Agent-room creation happens outside this pod-list hook. After navigation,
  // refresh the membership list once if that newly selected room is not in it
  // yet, so it immediately appears in the sidebar instead of waiting for a
  // later full-shell refresh.
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

  const needsYouTotal = attention.items.length;

  // Phone, no pod selected: the pods list IS the page.
  if (phone && !selectedPodId) {
    return (
      <div className="v2-shell v2-shell--list">
        <V2PodsSidebar
          selectedPodId={null}
          podsState={podsState}
          attentionItems={attention.items}
          variant="page"
        />
        <V2MobileTabs needsYouCount={needsYouTotal} />
        <V2FirstRunHero onVisibilityChange={setFirstRunVisible} />
      </div>
    );
  }

  // The inspector is a separate column only when expanded. When collapsed,
  // it's not rendered at all and the chat extends to the right edge — the
  // entry point is the toggle in the pod header (see V2Thread).
  const showInspector = Boolean(selectedPodId && !inspectorCollapsed);
  const shellClass = ['v2-shell', !showInspector ? 'v2-shell--no-inspector' : ''].filter(Boolean).join(' ');

  return (
    <div className={shellClass}>
      <V2NavRail />
      {!phone && (
        <V2PodsSidebar
          selectedPodId={selectedPodId}
          podsState={podsState}
          attentionItems={attention.items}
        />
      )}
      <V2Thread
        detail={detail}
        podsState={podsState}
        firstRunVisible={firstRunVisible}
        inspectorCollapsed={inspectorCollapsed}
        onToggleInspector={selectedPodId ? toggleInspector : undefined}
        onOpenMember={openInspector}
        onOpenInvite={inviteEnabled ? openInvite : undefined}
        onOpenFile={openFile}
        onBack={phone ? backToPods : undefined}
        onDecisionSettled={attention.refresh}
      />
      <V2MobileTabs needsYouCount={needsYouTotal} />
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
            attentionItems={attention.items}
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
