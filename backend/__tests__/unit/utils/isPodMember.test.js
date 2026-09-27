/**
 * TASK-170 (1).
 *
 * This module used to export a second, creator-inclusive rule three ways — the
 * default, the named `isPodMember`, and `isListedPodMember` beside them — so the
 * obvious spelling `require('../../utils/isPodMember')` bound the *permissive*
 * one. TASK-165's M2 mutation is exactly that edit and it stayed green.
 *
 * After TASK-166 nothing in production called the permissive rule (8 binders,
 * all destructuring `isListedPodMember`), so it is deleted. An absence cannot be
 * shown by execution, so the instrument here is the module's own shape: the
 * first arm reads the export object, with a positive control so a broken
 * `require` cannot pass for a deletion.
 */
const mod = require('../../../utils/isPodMember');
const { Types } = require('mongoose');

describe('utils/isPodMember', () => {
  it('exports no callable default: the bare require cannot reach a permissive rule', () => {
    expect(typeof mod).toBe('object');
    expect(typeof mod.isPodMember).toBe('undefined');
    expect(typeof mod.default).toBe('undefined');
    // Positive control. The arms above assert an absence, so a `require` that
    // returned something unexpected would satisfy them for the wrong reason.
    expect(typeof mod.isListedPodMember).toBe('function');
  });

  it('refuses a creator who is not listed', () => {
    const pod = { createdBy: 'creator-1', members: ['member-1'] };
    expect(mod.isListedPodMember(pod, 'creator-1')).toBe(false);
  });

  it('admits a creator who is listed: the arm above is not a blanket refusal', () => {
    const pod = { createdBy: 'creator-1', members: ['creator-1', 'member-1'] };
    expect(mod.isListedPodMember(pod, 'creator-1')).toBe(true);
  });

  it('admits a member as an ObjectId and as the same id in hex', () => {
    // The rule compares on `toString()`, so it does not depend on the mongoose
    // array wrapper having cast the caller for it. A predicate that only works
    // through the wrapper is the TASK-170 (3) trap, one layer down.
    const id = new Types.ObjectId();
    expect(mod.isListedPodMember({ members: [id] }, String(id))).toBe(true);
    expect(mod.isListedPodMember({ members: [id] }, id)).toBe(true);
  });

  it('admits a member document carrying `_id` (the hydrated shape)', () => {
    const id = new Types.ObjectId();
    const pod = { members: [{ _id: id }] };
    expect(mod.isListedPodMember(pod, String(id))).toBe(true);
  });

  it('refuses a missing pod, a missing caller, and a non-member', () => {
    expect(mod.isListedPodMember(null, 'user-1')).toBe(false);
    expect(mod.isListedPodMember({ members: ['user-1'] }, null)).toBe(false);
    expect(mod.isListedPodMember({ members: ['user-1'] }, 'user-2')).toBe(false);
  });
});
