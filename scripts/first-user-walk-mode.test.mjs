// Run: node --test scripts/first-user-walk-mode.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseWalkMode } from './first-user-walk-mode.mjs';

const STAGING = 'https://api-staging.commonly.me';
const PROD = 'https://api.commonly.me';

test('staging with COMMONLY_WALK_EMAIL takes the sign-in path', () => {
  assert.deepEqual(chooseWalkMode({ base: STAGING, env: { COMMONLY_WALK_EMAIL: 'walk@commonly.me' } }), { mode: 'signin', email: 'walk@commonly.me' });
});

test('no COMMONLY_WALK_EMAIL signs up a fresh account, on any target', () => {
  assert.deepEqual(chooseWalkMode({ base: PROD, env: {} }), { mode: 'signup' });
  assert.deepEqual(chooseWalkMode({ base: STAGING, env: {} }), { mode: 'signup' });
});

test('the shared sign-in account is refused on prod', () => {
  assert.throws(() => chooseWalkMode({ base: PROD, env: { COMMONLY_WALK_EMAIL: 'walk@commonly.me' } }), /staging only/);
});
