const {
  bindSocketIO,
  emitAgentTypingStart,
  emitAgentTypingStop,
} = require('../../../services/agentTypingService');

describe('agentTypingService', () => {
  let emit;
  let to;

  beforeEach(() => {
    jest.useFakeTimers();
    emit = jest.fn();
    to = jest.fn(() => ({ emit }));
    bindSocketIO({ to });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('is the server-side path that starts and stops a pod-scoped agent indicator', () => {
    emitAgentTypingStart({
      podId: 'pod-1',
      agentName: 'OpenClaw',
      instanceId: 'reviewer',
      displayName: 'Code Reviewer',
      avatar: 'avatar-url',
    });

    expect(to).toHaveBeenCalledWith('pod_pod-1');
    expect(emit).toHaveBeenCalledWith('agent_typing_start', {
      podId: 'pod-1',
      agentName: 'openclaw',
      instanceId: 'reviewer',
      displayName: 'Code Reviewer',
      avatar: 'avatar-url',
    });

    emitAgentTypingStop({ podId: 'pod-1', agentName: 'OpenClaw', instanceId: 'reviewer' });

    expect(emit).toHaveBeenLastCalledWith('agent_typing_stop', {
      podId: 'pod-1',
      agentName: 'openclaw',
      instanceId: 'reviewer',
    });
  });

  it('clears a typing indicator that does not receive a server-side stop', () => {
    emitAgentTypingStart({
      podId: 'pod-2',
      agentName: 'scout',
      displayName: 'Scout',
    });

    jest.advanceTimersByTime(30_000);

    expect(emit).toHaveBeenLastCalledWith('agent_typing_stop', {
      podId: 'pod-2',
      agentName: 'scout',
      instanceId: 'default',
    });
  });
});
