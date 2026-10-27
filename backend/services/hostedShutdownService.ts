import type { Server } from 'http';
import AgentEventService from './agentEventService';
import schedulerService from './schedulerService';

// Kubernetes grants 180s, including the existing 10s preStop delay. Native
// admission closes before HTTP stops; 150s covers the ~2 minute turn bound,
// leaving 15s for fenced requeues and 5s before the kubelet's hard kill.
export const HOSTED_SHUTDOWN_WATCHDOG_MS = 165_000;

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
    // Do not await WebSocket/keepalive clients: their lifetime does not bound
    // agent execution. The drain waits through its own terminal DB writes.
    server.close();
    server.closeIdleConnections();
    void drained.then((result) => {
      console.log('[shutdown] hosted drain complete', result);
      clearTimeout(watchdog);
      process.exit(0);
    }, (error: Error) => {
      console.error('[shutdown] hosted drain failed:', error.message);
      clearTimeout(watchdog);
      process.exit(1);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};
