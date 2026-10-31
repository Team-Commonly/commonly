import mongoose from 'mongoose';
import Pod from '../models/Pod';
import { requirePodMember } from './podMembershipService';
import { NON_LISTABLE_POD_TYPES } from './podListing';

// A grouping relation never grants access to either pod.
export async function validatePodParent(parentId: unknown, userId: unknown, childId?: string): Promise<{
  status: number; code: string; msg: string;
} | null> {
  if (parentId === null || parentId === undefined) return null;
  if (typeof parentId !== 'string' || !/^[a-f\d]{24}$/i.test(parentId)) {
    return { status: 400, code: 'invalid_parent_pod', msg: 'Parent pod must be a pod ID or null' };
  }
  if (childId?.toLowerCase() === parentId.toLowerCase()) {
    return { status: 400, code: 'pod_parent_cycle', msg: 'A pod cannot parent itself' };
  }
  const access = await requirePodMember(parentId, userId, { write: true });
  if (access.error) return {
    status: access.status === 404 ? 400 : 403,
    code: access.status === 404 ? 'parent_pod_not_found' : 'parent_pod_write_denied',
    msg: access.status === 404 ? 'Parent pod not found' : 'Write membership in the parent pod is required',
  };
  const parent = access.pod as { type?: string; parentPod?: unknown };
  if (NON_LISTABLE_POD_TYPES.includes(parent.type || '')) {
    return { status: 400, code: 'invalid_parent_pod_type', msg: 'Private agent rooms cannot be parent pods' };
  }
  if (parent.parentPod) return { status: 400, code: 'pod_parent_depth', msg: 'A child pod cannot be a parent' };
  if (childId && await Pod.exists({ parentPod: new mongoose.Types.ObjectId(childId) })) {
    return { status: 400, code: 'pod_parent_depth', msg: 'A parent pod cannot become a child' };
  }
  return null;
}
