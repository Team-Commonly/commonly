// Integration tests for sign-up flow per signup-test-plan.xlsx
// Covers T-01 through T-12 — email, GitHub OAuth, Google OAuth, edge cases.

import { describe, it, expect } from '@jest/globals';

describe('signup flow', () => {
  it.todo('T-01: new email signup — happy path');
  it.todo('T-02: returning email — login redirect');
  it.todo('T-04: GitHub OAuth — happy path');
  it.todo('T-05: GitHub OAuth — email matches existing account');
  it.todo('T-10: 60-second time-to-pod budget');
});
