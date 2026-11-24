import type { Server } from 'http';
import AgentEventService from './agentEventService';
import schedulerService from './schedulerService';
import { endAllWaits, heldPollCount, waitForHeldPolls } from './agentEventWaiters';

// Kubernetes grants 180s, including the existing 10s preStop delay. Native
// admission closes before HTTP stops; 150s covers the ~2 minute turn bound,
// leaving 15s for fenced requeues and 5s before the kubelet's hard kill.
export const HOSTED_SHUTDOWN_WATCHDOG_MS = 165_000;
// F597: how long the exit waits for held event polls still answering (one
// that was claiming after a wake when the shutdown began).
export const HELD_POLL_EXIT_BOUND_MS = 2_000;

// Run `exit` once no held poll is mid-answer, bounded. Synchronous when none
// is, so an idle shutdown exits exactly as it did before.
const afterHeldPolls = (exit: () => void): void => {
  if (heldPollCount() === 0) {
    exit();
    return;
  }
  void waitForHeldPolls(HELD_POLL_EXIT_BOUND_MS).then(exit);
};

export const installHostedShutdown = (server: Server): void => {
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const watchdog = setTimeout(() => {
      console.error('[shutdown] hosted drain exceeded shutdown budget');
      process.exit(1);
    }, HOSTED_SHUTDOWN_WATCHDOG_MS);
    const drained = AgentEventService.drainInProcess();
    schedulerService.stop();
    // F597: answer held event polls now, empty; their agents poll again.
    endAllWaits();
    // Do not await WebSocket/keepalive clients: their lifetime does not bound
    // agent execution. The drain waits through its own terminal DB writes.
    server.close();
    server.closeIdleConnections();
    void drained.then((result) => {
      console.log('[shutdown] hosted drain complete', result);
      afterHeldPolls(() => {
        clearTimeout(watchdog);
        process.exit(0);
      });
    }, (error: Error) => {
      console.error('[shutdown] hosted drain failed:', error.message);
      afterHeldPolls(() => {
        clearTimeout(watchdog);
        process.exit(1);
      });
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};
