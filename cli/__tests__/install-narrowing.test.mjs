/**
 * F167: the install route answers 409 outsider_grant_narrowing_confirm_required
 * when joining this pod would confine the seat's writes elsewhere (F164). Its
 * text ends "Send confirmNarrowing: true to install anyway", which is API advice
 * a CLI user can't act on, and the CLI had no flag to send it.
 */
import { describe, expect, test } from '@jest/globals';
import {
  NARROWING_CONFIRM_CODE, explainNarrowing, narrowingConfirmBody,
} from '../src/lib/install-narrowing.js';

const refusal = (message) => Object.assign(new Error(message), {
  status: 409,
  body: { code: NARROWING_CONFIRM_CODE, message, narrowing: { losesWrites: [{ name: 'Ops' }] } },
});

describe('install narrowing (F167)', () => {
  test('the flag sends confirmNarrowing: true, and nothing without it', () => {
    expect(narrowingConfirmBody(true)).toEqual({ confirmNarrowing: true });
    expect(narrowingConfirmBody(false)).toEqual({});
    expect(narrowingConfirmBody(undefined)).toEqual({});
  });

  test('the refusal names the CLI flag in place of the API field', () => {
    const err = explainNarrowing(refusal(
      "An outside-writable grant would reach scout's pods, so it would stop writing in Ops. "
      + 'Send confirmNarrowing: true to install anyway.',
    ));
    expect(err.message).toBe(
      "An outside-writable grant would reach scout's pods, so it would stop writing in Ops. "
      + 'Re-run with --confirm-narrowing to install anyway.',
    );
    expect(err).toMatchObject({ status: 409, code: NARROWING_CONFIRM_CODE });
    expect(err.body.narrowing).toEqual({ losesWrites: [{ name: 'Ops' }] });
  });

  test('a server text without the API sentence still gets the flag', () => {
    expect(explainNarrowing(refusal('It would stop writing in Ops.')).message)
      .toBe('It would stop writing in Ops. Re-run with --confirm-narrowing to install anyway.');
  });

  test('any other error is returned unchanged', () => {
    const other = Object.assign(new Error('Pod not found'), { status: 404, body: { error: 'Pod not found' } });
    expect(explainNarrowing(other)).toBe(other);
    const conflict = Object.assign(new Error('held'), { status: 409, body: { code: 'runtime_token_held' } });
    expect(explainNarrowing(conflict)).toBe(conflict);
    const plain = new Error('fetch failed');
    expect(explainNarrowing(plain)).toBe(plain);
  });
});
