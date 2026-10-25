jest.mock('../../../services/agentEventService', () => ({ drainInProcess: jest.fn() }));
jest.mock('../../../services/schedulerService', () => ({ stop: jest.fn() }));
const fs = require('fs'), path = require('path');
const service = require('../../../services/agentEventService');
const scheduler = require('../../../services/schedulerService');
const { installHostedShutdown, HOSTED_SHUTDOWN_WATCHDOG_MS } = require('../../../services/hostedShutdownService');
let handlers, server, exit;
beforeEach(() => {
  jest.useFakeTimers(); jest.clearAllMocks(); handlers = {};
  jest.spyOn(process, 'on').mockImplementation((name, handler) => { handlers[name] = handler; return process; });
  exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
  server = { close: jest.fn(), closeIdleConnections: jest.fn() };
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
test('SIGTERM gates admission before closing HTTP; exits after drain; repeated signals are idempotent', async () => {
  let resolve; service.drainInProcess.mockImplementation(() => new Promise((done) => { resolve = done; }));
  installHostedShutdown(server); handlers.SIGTERM(); handlers.SIGTERM(); handlers.SIGINT();
  expect(service.drainInProcess).toHaveBeenCalledTimes(1); expect(scheduler.stop).toHaveBeenCalledTimes(1);
  expect(service.drainInProcess.mock.invocationCallOrder[0]).toBeLessThan(server.close.mock.invocationCallOrder[0]);
  expect(server.close).toHaveBeenCalledTimes(1); expect(exit).not.toHaveBeenCalled();
  resolve({ timedOut: false, requeued: 0 }); await flush(); expect(exit).toHaveBeenCalledWith(0);
  jest.advanceTimersByTime(HOSTED_SHUTDOWN_WATCHDOG_MS); expect(exit).toHaveBeenCalledTimes(1);
});
test('watchdog bounds stuck cleanup inside the Kubernetes budget', () => {
  service.drainInProcess.mockReturnValue(new Promise(() => {}));
  installHostedShutdown(server); handlers.SIGTERM();
  jest.advanceTimersByTime(HOSTED_SHUTDOWN_WATCHDOG_MS - 1); expect(exit).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1); expect(exit).toHaveBeenCalledWith(1);
  const chart = fs.readFileSync(path.resolve(__dirname, '../../../../k8s/helm/commonly/templates/core/backend-deployment.yaml'), 'utf8');
  expect(Number(/terminationGracePeriodSeconds: (\d+)/.exec(chart)[1]) * 1000).toBeGreaterThan(10000 + HOSTED_SHUTDOWN_WATCHDOG_MS);
});
test('cleanup failure exits nonzero', async () => {
  service.drainInProcess.mockRejectedValue(new Error('database unavailable'));
  installHostedShutdown(server); handlers.SIGTERM(); await flush(); expect(exit).toHaveBeenCalledWith(1);
});
