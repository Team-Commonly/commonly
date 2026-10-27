import { recordByoStep, recordByoStepOnce, resetByoStepsForTest } from '../utils/byoTelemetry';

const post = jest.fn();
const api = { post } as unknown as Parameters<typeof recordByoStep>[0];

beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue({});
  resetByoStepsForTest();
});

test('a surface step is sent once per page load, each step on its own', () => {
  recordByoStepOnce(api, 'invite-card-shown', 'maya');
  recordByoStepOnce(api, 'invite-card-shown', 'maya');
  recordByoStepOnce(api, 'byo-offer-shown', 'maya');
  expect(post.mock.calls).toEqual([
    ['/api/stats/byo-step', { step: 'invite-card-shown' }],
    ['/api/stats/byo-step', { step: 'byo-offer-shown' }],
  ]);
});

test('a failed ping never throws into the caller', async () => {
  post.mockRejectedValue(new Error('offline'));
  expect(() => recordByoStep(api, 'invite-card-dismissed')).not.toThrow();
  await Promise.resolve();
});

test('switching accounts in the same page load sends the step once for each person', () => {
  recordByoStepOnce(api, 'invite-card-shown', 'maya');
  recordByoStepOnce(api, 'invite-card-shown', 'jordan');
  recordByoStepOnce(api, 'invite-card-shown', 'jordan');
  expect(post).toHaveBeenCalledTimes(2);
});

test('a step stays suppressed while in flight and is retried after a failed POST', async () => {
  let reject: (e: Error) => void = () => undefined;
  post.mockReturnValueOnce(new Promise((_, r) => { reject = r; }));
  recordByoStepOnce(api, 'byo-offer-shown', 'maya');
  recordByoStepOnce(api, 'byo-offer-shown', 'maya');
  expect(post).toHaveBeenCalledTimes(1);
  reject(new Error('offline'));
  await new Promise((r) => setTimeout(r, 0));
  recordByoStepOnce(api, 'byo-offer-shown', 'maya');
  expect(post).toHaveBeenCalledTimes(2);
});
