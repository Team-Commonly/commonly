import { recordByoStep, recordByoStepOnce, resetByoStepsForTest } from '../utils/byoTelemetry';

const post = jest.fn();
const api = { post } as unknown as Parameters<typeof recordByoStep>[0];

beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue({});
  resetByoStepsForTest();
});

test('a surface step is sent once per page load, each step on its own', () => {
  recordByoStepOnce(api, 'invite-card-shown');
  recordByoStepOnce(api, 'invite-card-shown');
  recordByoStepOnce(api, 'byo-offer-shown');
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
