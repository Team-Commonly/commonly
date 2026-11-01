// Run: node --test scripts/first-user-walk-mode.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseWalkMode } from './first-user-walk-mode.mjs';

const STAGING = 'https://api-staging.commonly.me';
const PROD = 'https://api.commonly.me';

test('staging with COMMONLY_WALK_EMAIL takes the sign-in path', () => {
  assert.deepEqual(chooseWalkMode({ base: STAGING, env: { COMMONLY_WALK_EMAIL: 'walk@commonly.me' } }), { mode: 'signin', email: 'walk@commonly.me', deleteAccount: false });
});

test('no COMMONLY_WALK_EMAIL signs up a fresh account on staging, and that account is deleted', () => {
  assert.deepEqual(chooseWalkMode({ base: STAGING, env: {} }), { mode: 'signup', deleteAccount: true });
});

test('prod never signs up: it signs in to the existing account from env, which is never deleted', () => {
  assert.deepEqual(chooseWalkMode({ base: PROD, env: { COMMONLY_WALK_EMAIL: 'walk-test@commonly.me' } }), { mode: 'signin-prod', email: 'walk-test@commonly.me', deleteAccount: false });
});

test('prod without an existing test account is refused, not signed up', () => {
  assert.throws(() => chooseWalkMode({ base: PROD, env: {} }), /no walk signup/);
});


test('a host that merely contains "staging" never receives the shared account', () => {
  for (const base of ['https://staging.attacker.example', 'https://api-staging.commonly.me.attacker.example', 'https://evil-staging.example']) {
    assert.throws(() => chooseWalkMode({ base, env: { COMMONLY_WALK_EMAIL: 'walk@commonly.me' } }), /staging API over https/, base);
  }
});

test('the shared sign-in account is refused over plain http, even on the staging host', () => {
  assert.throws(() => chooseWalkMode({ base: 'http://api-staging.commonly.me', env: { COMMONLY_WALK_EMAIL: 'walk@commonly.me' } }), /over https/);
});
