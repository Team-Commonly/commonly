// #985: AGENT_ASK_RATE_LIMIT_PER_HOUR=0 resolved to 30 — the most restrictive
// setting silently produced the most permissive one.
//
// These pin the DELIVERED constant (__testing__.ASK_RATE_LIMIT_PER_HOUR),
// re-required under each env value, rather than a extracted resolver. A test
// against a helper stays green if a later edit stops routing the env var
// through it; this one cannot.
//
// The models are mocked because AgentRegistry.ts calls mongoose.model()
// unguarded, so jest.resetModules() + re-require would throw
// OverwriteModelError. Nothing here reaches the database.

jest.mock('../../../services/agentEventService', () => ({ enqueue: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({ AgentInstallation: {} }));
jest.mock('../../../models/AgentAsk', () => ({}));

const ENV_KEY = 'AGENT_ASK_RATE_LIMIT_PER_HOUR';
const original = process.env[ENV_KEY];

const limitFor = (raw) => {
  jest.resetModules();
  if (raw === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = raw;
  // eslint-disable-next-line global-require
  return require('../../../services/agentAskService').__testing__.ASK_RATE_LIMIT_PER_HOUR;
};

afterAll(() => {
  if (original === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = original;
});

describe('ASK_RATE_LIMIT_PER_HOUR env resolution (#985)', () => {
  it('clamps 0 to the floor instead of falling through to the default', () => {
    expect(limitFor('0')).toBe(1);
  });

  it('clamps a sub-1 fraction to the floor — parseInt("0.5") is a falsy 0', () => {
    expect(limitFor('0.5')).toBe(1);
  });

  // Control: this case was already correct before the fix. It is here so a
  // regression that swings the other way — treating every unparsable value as
  // the floor — fails instead of looking like a stricter version of the fix.
  it('still falls back to the default for a non-numeric value', () => {
    expect(limitFor('abc')).toBe(30);
  });

  // Control pair: absence must stay absence. An empty string is how a k8s env
  // block spells "unset", and it must not read as a 0 now that 0 no longer
  // routes to the default by accident.
  it('falls back to the default when unset', () => {
    expect(limitFor(undefined)).toBe(30);
  });

  it('falls back to the default for an empty string', () => {
    expect(limitFor('')).toBe(30);
  });

  it('clamps a negative to the floor, as it always did', () => {
    expect(limitFor('-5')).toBe(1);
  });

  it('passes a normal value through untouched', () => {
    expect(limitFor('7')).toBe(7);
  });
});
