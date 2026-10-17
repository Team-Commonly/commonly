import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { V2ApiClient } from './useV2Api';
import type { V2Start } from './useV2PodDetail';
import { DEFAULT_INSTALL_SCOPES } from '../utils/agentInstallScopes';

/** The action on Scout's welcome "Run an agent here" (backend/services/welcomeHostedStart.ts). */
export const WELCOME_HOSTED_ACTION = 'run-hosted';

interface WelcomeStartPlan {
  podId: string;
  existing: { agentName: string; instanceId: string; podId: string } | null;
  agentName: string | null;
}

export type WelcomeHostedStartState =
  | { messageId: string; status: 'starting' }
  | { messageId: string; status: 'live' }
  | { messageId: string; status: 'failed'; error: string }
  | null;

type ApiError = {
  response?: { status?: number; data?: { code?: string; message?: string; error?: string; cap?: number } };
  message?: string;
};

// Answers that mean "this click cannot run here": the page it links to can.
const OPEN_PAGE_CODES = new Set(['not_welcome_start', 'agent_name_unavailable']);

// The install refused the name (taken, reserved, or bound to another
// identity). The page it links to lets the person choose one.
class NameRefused extends Error {}

/**
 * One click on the welcome's "Run an agent here" starts a hosted agent in
 * place (TASK-290): the click is the consent, and there is no page between.
 *
 * The server answers what to start (POST /api/hosted/welcome-start): the
 * hosted agent this person already holds, or a free name for a new one. The
 * install and provision are the same calls the Bring your own page makes. A
 * failed install asks again: when another click (here or in another tab) got
 * there first, the answer is now that agent, and this click starts it too.
 */
export function useWelcomeHostedStart(
  api: V2ApiClient,
  { onLive, onOpenPage }: { onLive: () => void; onOpenPage: (href: string) => void },
) {
  const { t } = useTranslation();
  const [state, setState] = useState<WelcomeHostedStartState>(null);
  const inFlight = useRef(false);

  const run = useCallback(async (messageId: string, start: V2Start) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setState({ messageId, status: 'starting' });
    try {
      const resolve = () => api.post<WelcomeStartPlan>('/api/hosted/welcome-start', { messageId });
      let plan = await resolve();
      if (!plan.existing && plan.agentName) {
        try {
          await api.post('/api/registry/install', {
            agentName: plan.agentName,
            podId: plan.podId,
            scopes: DEFAULT_INSTALL_SCOPES,
            config: { runtime: { runtimeType: 'hosted' } },
            displayName: plan.agentName,
          });
        } catch (installError) {
          plan = await resolve();
          if (!plan.existing) {
            throw (installError as ApiError).response?.status === 409 ? new NameRefused() : installError;
          }
        }
      }
      const agent = plan.existing || { agentName: plan.agentName as string, instanceId: undefined };
      await api.post('/api/hosted/provision', {
        agentName: agent.agentName,
        ...(agent.instanceId ? { instanceId: agent.instanceId } : {}),
      });
      setState({ messageId, status: 'live' });
      onLive();
    } catch (err) {
      const data = (err as ApiError).response?.data;
      const openPage = err instanceof NameRefused || Boolean(data?.code && OPEN_PAGE_CODES.has(data.code));
      if (openPage && start.href) {
        setState(null);
        onOpenPage(start.href);
        return;
      }
      let error: string;
      if (data?.code === 'hosted_cap_reached') error = t('agentByo.errors.hostedCap', { cap: data.cap ?? 1 });
      else if (data?.code === 'hosted_runtime_unconfigured') error = t('agentByo.errors.hostedUnavailable');
      else error = data?.message || data?.error || t('agentByo.errors.installFailed');
      setState({ messageId, status: 'failed', error });
    } finally {
      inFlight.current = false;
    }
  }, [api, onLive, onOpenPage, t]);

  return { state, run };
}
