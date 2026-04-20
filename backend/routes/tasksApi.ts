// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const mongoose = require('mongoose');
// eslint-disable-next-line global-require
const regularAuth = require('../middleware/auth');
// eslint-disable-next-line global-require
const agentRuntimeAuth = require('../middleware/agentRuntimeAuth');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const Task = require('../models/Task');
// eslint-disable-next-line global-require
const User = require('../models/User');
// eslint-disable-next-line global-require
const { AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line global-require
const GitHubAppService = require('../services/githubAppService');
// eslint-disable-next-line global-require
const AgentEventService = require('../services/agentEventService');
// eslint-disable-next-line global-require
const { emitTaskUpdated } = require('../services/taskEventService');

interface AuthReq {
  userId?: string;
  user?: { id?: string; _id?: unknown; isBot?: boolean; botMetadata?: { instanceId?: string; agentName?: string } };
  agentUser?: { _id?: unknown };
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  header?: (name: string) => string | undefined;
}
interface Res {
  status: (n: number) => Res;
  json: (d: unknown) => void;
}

function auth(req: AuthReq, res: Res, next: () => void) {
  const token = ((req.header?.('Authorization') || '').replace('Bearer ', ''));
  if (token.startsWith('cm_agent_')) return agentRuntimeAuth(req, res, next);
  return regularAuth(req, res, next);
}

const router: ReturnType<typeof express.Router> = express.Router();

async function resolveAuthor(req: AuthReq): Promise<string> {
  const agentInstance = req.user?.isBot ? (req.user.botMetadata?.instanceId || req.user.botMetadata?.agentName) : null;
  if (agentInstance) return agentInstance;
  const userId = req.userId || req.user?._id || req.user?.id || req.agentUser?._id;
  if (userId) {
    const u = await User.findById(userId).select('username').lean() as { username?: string } | null;
    if (u?.username) return u.username;
  }
  return 'unknown';
}

function resolveAgentInstanceId(req: AuthReq): string | null {
  if (!req.user?.isBot) return null;
  return req.user.botMetadata?.instanceId || req.user.botMetadata?.agentName || null;
}

function slugify(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function enqueueTaskAssignedIfNeeded({
  podId,
  task,
}: {
  podId: string;
  task: Record<string, unknown>;
}): Promise<void> {
  if (!task || task.assigneeType !== 'agent') return;

  const assigneeRef = String(task.assigneeRef || '').trim().toLowerCase();
  const assigneeLabel = String(task.assignee || '').trim();

  let installation = null;
  if (assigneeRef) {
    installation = await AgentInstallation.findOne({
      podId: mongoose.Types.ObjectId.createFromHexString(podId),
      instanceId: assigneeRef,
      status: 'active',
    }).lean();
  }

  if (!installation && assigneeLabel) {
    const installs = await AgentInstallation.find({
      podId: mongoose.Types.ObjectId.createFromHexString(podId),
      status: 'active',
    }).select('agentName instanceId displayName').lean();
    const normalizedLabel = slugify(assigneeLabel);
    installation = installs.find((item: any) => (
      slugify(item.instanceId) === normalizedLabel
      || slugify(item.displayName) === normalizedLabel
      || slugify(item.agentName) === normalizedLabel
      || slugify(`${item.agentName}-${item.instanceId}`) === normalizedLabel
    )) || null;
  }

  if (!installation) return;

  await AgentEventService.enqueue({
    agentName: installation.agentName,
    instanceId: installation.instanceId || 'default',
    podId,
    type: 'task.assigned',
    payload: {
      taskId: task.taskId,
      title: task.title,
      description: task.description || null,
      notes: task.notes || null,
      priority: task.priority || 'medium',
      dueDate: task.dueDate || null,
      progressPercent: task.progressPercent ?? 0,
      assignee: task.assignee || null,
      assigneeRef: task.assigneeRef || null,
      dep: task.dep || null,
      parentTask: task.parentTask || null,
      blocker: task.blocker || null,
    },
  });
}

async function requirePodMember(podId: string, userId: unknown, { write = false } = {}): Promise<{ error?: string; status?: number; pod?: unknown }> {
  const pod = await Pod.findById(podId).lean() as { members?: Array<{ userId?: { toString: () => string }; toString: () => string; role?: string }> } | null;
  if (!pod) return { error: 'Pod not found', status: 404 };
  const membership = pod.members?.find((m) => {
    if (!m) return false;
    const id = m.userId ? m.userId.toString() : m.toString();
    return id === (userId as { toString: () => string }).toString();
  });
  if (!membership) return { error: 'Access denied', status: 403 };
  if (write && (membership as { role?: string }).role === 'viewer') return { error: 'Write access denied', status: 403 };
  return { pod };
}

async function nextTaskId(podId: string): Promise<{ taskId: string; taskNum: number }> {
  const last = await Task.findOne({ podId, taskId: { $exists: true } }).sort({ taskId: -1 }).select('taskId').lean() as { taskId?: string } | null;
  const lastNum = last ? parseInt((last.taskId || '').replace('TASK-', ''), 10) : 0;
  const num = lastNum + 1;
  return { taskId: `TASK-${String(num).padStart(3, '0')}`, taskNum: num };
}

router.get('/:podId', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId } = req.params || {};
    const userId = req.userId || req.user?._id || req.agentUser?._id;
    const { assignee, status } = req.query || {};
    const access = await requirePodMember(podId || '', userId);
    if (access.error) return res.status(access.status || 500).json({ error: access.error });
    const query: Record<string, unknown> = { podId: mongoose.Types.ObjectId.createFromHexString(podId || '') };
    if (assignee) query.assignee = assignee;
    if (status) query.status = status.includes(',') ? { $in: status.split(',') } : status;
    const tasks = await Task.find(query).sort({ taskNum: 1 }).lean();
    return res.json({ tasks });
  } catch (err) {
    console.error('GET /tasks error:', err);
    return res.status(500).json({ error: 'Failed to list tasks' });
  }
});

router.post('/:podId', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId } = req.params || {};
    const userId = req.userId || req.user?._id || req.agentUser?._id;
    const {
      title, description, assignee, assigneeType, assigneeRef, dep, depMockOk, parentTask,
      source, sourceRef, githubIssueNumber, githubIssueUrl, createGithubIssue, priority, dueDate,
    } = (req.body || {}) as {
      title?: string;
      description?: string;
      assignee?: string;
      assigneeType?: 'human' | 'agent';
      assigneeRef?: string;
      dep?: string;
      depMockOk?: boolean;
      parentTask?: string;
      source?: string;
      sourceRef?: string;
      githubIssueNumber?: number;
      githubIssueUrl?: string;
      createGithubIssue?: boolean;
      priority?: 'low' | 'medium' | 'high';
      dueDate?: string;
    };
    if (!title) return res.status(400).json({ error: 'title is required' });
    const access = await requirePodMember(podId || '', userId, { write: true });
    if (access.error) return res.status(access.status || 500).json({ error: access.error });
    if (sourceRef) {
      const existing = await Task.findOne({ podId: mongoose.Types.ObjectId.createFromHexString(podId || ''), sourceRef }) as { status?: string; assignee?: string; claimedAt?: Date | null; notes?: string; updates: Array<{ text: string; author: string; authorId: string | null; createdAt: Date }>; save: () => Promise<void>; toObject: () => unknown } | null;
      if (existing) {
        if (existing.status === 'done') {
          existing.status = 'pending';
          existing.assignee = assignee || undefined;
          existing.claimedAt = null;
          existing.notes = 'Reopened — previously completed but issue is still open.';
          existing.updates.push({ text: 'Reopened: task was done but linked issue is still open — picking up again.', author: 'system', authorId: null, createdAt: new Date() });
          await existing.save();
          const reopenedObj = existing.toObject();
          emitTaskUpdated(podId, reopenedObj, 'updated');
          return res.json({ task: reopenedObj, alreadyExists: false, reopened: true });
        }
        return res.json({ task: existing.toObject(), alreadyExists: true });
      }
    }
    let ghNumber = githubIssueNumber || null;
    let ghUrl = githubIssueUrl || null;
    if (createGithubIssue && title && GitHubAppService.isPatConfigured()) {
      try {
        const bodyParts: string[] = [];
        if (assignee) bodyParts.push(`Assigned to: ${assignee}`);
        if (parentTask) bodyParts.push(`Parent task: ${parentTask}`);
        if (dep) bodyParts.push(`Blocked by: ${dep}`);
        const issue = await GitHubAppService.createIssue({ title, body: bodyParts.join('\n') || undefined }) as { number: number; html_url: string };
        ghNumber = issue.number;
        ghUrl = issue.html_url;
      } catch (ghErr) {
        console.warn('createGithubIssue failed (non-fatal):', (ghErr as Error).message);
      }
    }
    const author = await resolveAuthor(req);
    const { taskId, taskNum } = await nextTaskId(podId || '');
    const initUpdate: { text: string; author: string; authorId: string | null; createdAt: Date } = { text: `Created by ${author}`, author, authorId: userId?.toString() || null, createdAt: new Date() };
    if (assignee) initUpdate.text = `Created by ${author} · assigned to ${assignee}`;
    if (sourceRef) initUpdate.text = `Created by ${author} from ${sourceRef}${assignee ? ` · assigned to ${assignee}` : ''}`;
    if (ghNumber) initUpdate.text += ` · GH#${ghNumber}`;
    if (parentTask) initUpdate.text += ` · sub-task of ${parentTask}`;
    const task = await Task.create({
      podId,
      taskNum,
      taskId,
      title,
      description: description || null,
      assignee: assignee || null,
      assigneeType: assigneeType || (assignee ? 'human' : null),
      assigneeRef: assigneeRef || null,
      dep: dep || null,
      depMockOk: !!depMockOk,
      parentTask: parentTask || null,
      priority: priority || 'medium',
      dueDate: dueDate ? new Date(dueDate) : null,
      source: source || (ghNumber ? 'github' : 'human'),
      sourceRef: sourceRef || (ghNumber ? `GH#${ghNumber}` : undefined),
      githubIssueNumber: ghNumber,
      githubIssueUrl: ghUrl,
      updates: [initUpdate],
    });
    if (parentTask && GitHubAppService.isPatConfigured()) {
      try {
        const parent = await Task.findOne({ podId: mongoose.Types.ObjectId.createFromHexString(podId || ''), taskId: parentTask }).lean() as { githubIssueNumber?: number } | null;
        if (parent?.githubIssueNumber) {
          const depNote = dep ? ` (blocked by ${dep})` : '';
          GitHubAppService.addIssueComment({ issueNumber: parent.githubIssueNumber, comment: `**Sub-task created:** ${taskId} — ${title}${depNote}\nAssigned to: ${assignee || 'unassigned'}` }).catch((e: Error) => console.warn('GH sub-task comment failed:', e.message));
        }
      } catch (e) {
        console.warn('Parent GH lookup failed (non-fatal):', (e as Error).message);
      }
    }
    emitTaskUpdated(podId, task, 'created');
    await enqueueTaskAssignedIfNeeded({
      podId,
      task: task.toObject ? task.toObject() : task,
    });
    return res.status(201).json({ task });
  } catch (err) {
    console.error('POST /tasks error:', err);
    return res.status(500).json({ error: 'Failed to create task' });
  }
});

router.post('/:podId/:taskId/claim', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId, taskId } = req.params || {};
    const userId = req.userId || req.user?._id || req.agentUser?._id;
    const agentId = resolveAgentInstanceId(req);
    const claimedBy = agentId || userId?.toString() || '';
    const access = await requirePodMember(podId || '', userId, { write: true });
    if (access.error) return res.status(access.status || 500).json({ error: access.error });
    const update = { $set: { status: 'claimed', claimedBy, claimedAt: new Date() }, $push: { updates: { text: `Claimed by ${claimedBy}`, author: claimedBy, authorId: userId?.toString() || null, createdAt: new Date() } } };
    const task = await Task.findOneAndUpdate({ podId: mongoose.Types.ObjectId.createFromHexString(podId || ''), taskId, status: 'pending' }, update, { new: true });
    if (!task) {
      const existing = await Task.findOne({ podId: mongoose.Types.ObjectId.createFromHexString(podId || ''), taskId }).lean() as { claimedBy?: string; status?: string } | null;
      if (!existing) return res.status(404).json({ error: 'Task not found' });
      return res.status(409).json({ error: 'Task already claimed', claimedBy: existing.claimedBy, status: existing.status });
    }
    emitTaskUpdated(podId, task, 'updated');
    return res.json({ task });
  } catch (err) {
    console.error('POST /tasks/claim error:', err);
    return res.status(500).json({ error: 'Failed to claim task' });
  }
});

router.post('/:podId/:taskId/complete', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId, taskId } = req.params || {};
    const userId = req.userId || req.user?._id || req.agentUser?._id;
    const { prUrl, notes } = (req.body || {}) as { prUrl?: string; notes?: string };
    const author = await resolveAuthor(req);
    const access = await requirePodMember(podId || '', userId, { write: true });
    if (access.error) return res.status(access.status || 500).json({ error: access.error });
    const updateText = prUrl ? `Completed by ${author} · PR: ${prUrl}` : `Completed by ${author}`;
    const update = {
      $set: {
        status: 'done',
        completedAt: new Date(),
        progressPercent: 100,
        blocker: {
          open: false,
          reason: null,
          waitingOn: null,
          severity: 'medium',
          openedAt: null,
          openedBy: null,
          resolvedAt: new Date(),
        },
        ...(prUrl && { prUrl }),
        ...(notes && { notes }),
      },
      $push: {
        updates: {
          text: updateText,
          author,
          authorId: userId?.toString() || null,
          createdAt: new Date(),
          kind: 'completion',
          progressPercent: 100,
        },
      },
    };
    const task = await Task.findOneAndUpdate({ podId: mongoose.Types.ObjectId.createFromHexString(podId || ''), taskId, status: { $in: ['claimed', 'pending'] } }, update, { new: true }) as { githubIssueNumber?: number; taskId?: string; updates?: unknown[] } | null;
    if (!task) {
      const existing = await Task.findOne({ podId: mongoose.Types.ObjectId.createFromHexString(podId || ''), taskId }).lean() as { status?: string } | null;
      if (!existing) return res.status(404).json({ error: 'Task not found' });
      return res.status(409).json({ error: 'Task is already done', status: existing.status });
    }
    if (task.githubIssueNumber && GitHubAppService.isPatConfigured()) {
      (async () => {
        try {
          const subTasks = await Task.find({ podId: mongoose.Types.ObjectId.createFromHexString(podId || ''), parentTask: task.taskId }).select('taskId title status prUrl').lean() as Array<{ taskId?: string; title?: string; status?: string; prUrl?: string }>;
          let closeComment = prUrl ? `Completed via ${prUrl}` : `Completed by ${author}`;
          if (subTasks.length > 0) {
            const subLines = subTasks.map((s) => { const icon = s.status === 'done' ? '✅' : s.status === 'blocked' ? '❌' : '⏳'; return `${icon} ${s.taskId}: ${s.title}${s.prUrl ? ` — [PR](${s.prUrl})` : ''}`; });
            closeComment += `\n\n**Sub-tasks:**\n${subLines.join('\n')}`;
          }
          await GitHubAppService.closeIssue({ issueNumber: task.githubIssueNumber, comment: closeComment });
        } catch (err) {
          console.warn(`Failed to auto-close GH#${task.githubIssueNumber}:`, (err as Error).message);
        }
      })();
    }
    emitTaskUpdated(podId, task, 'updated');
    return res.json({ task });
  } catch (err) {
    console.error('POST /tasks/complete error:', err);
    return res.status(500).json({ error: 'Failed to complete task' });
  }
});

router.post('/:podId/:taskId/updates', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId, taskId } = req.params || {};
    const userId = req.userId || req.user?._id || req.agentUser?._id;
    const { text, kind, progressPercent, nextStep } = (req.body || {}) as {
      text?: string;
      kind?: 'note' | 'progress' | 'blocker' | 'handoff' | 'decision' | 'completion';
      progressPercent?: number;
      nextStep?: string;
    };
    if (!text?.trim()) return res.status(400).json({ error: 'text is required' });
    const access = await requirePodMember(podId || '', userId, { write: true });
    if (access.error) return res.status(access.status || 500).json({ error: access.error });
    const author = await resolveAuthor(req);
    const updatePayload: Record<string, unknown> = {
      text: text.trim(),
      author,
      authorId: userId?.toString() || null,
      createdAt: new Date(),
      kind: kind || 'note',
    };
    if (progressPercent !== undefined && progressPercent !== null) {
      updatePayload.progressPercent = Math.max(0, Math.min(100, Number(progressPercent)));
    }
    if (nextStep) updatePayload.nextStep = String(nextStep);
    const taskUpdate: Record<string, unknown> = {
      $push: { updates: updatePayload },
    };
    if (progressPercent !== undefined && progressPercent !== null) {
      taskUpdate.$set = { progressPercent: Math.max(0, Math.min(100, Number(progressPercent))) };
    }
    const task = await Task.findOneAndUpdate(
      { podId: mongoose.Types.ObjectId.createFromHexString(podId || ''), taskId },
      taskUpdate,
      { new: true },
    );
    if (!task) return res.status(404).json({ error: 'Task not found' });
    emitTaskUpdated(podId, task, 'updated');
    return res.json({ task });
  } catch (err) {
    console.error('POST /tasks/updates error:', err);
    return res.status(500).json({ error: 'Failed to add update' });
  }
});

router.patch('/:podId/:taskId', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId, taskId } = req.params || {};
    const userId = req.userId || req.user?._id || req.agentUser?._id;
    const allowed = [
      'title', 'description', 'assignee', 'assigneeType', 'assigneeRef', 'dep', 'depMockOk', 'parentTask',
      'status', 'notes', 'prUrl', 'priority', 'dueDate', 'progressPercent', 'blocker',
    ];
    const fieldUpdates: Record<string, unknown> = {};
    const body = (req.body || {}) as Record<string, unknown>;
    allowed.forEach((k) => { if (body[k] !== undefined) fieldUpdates[k] = body[k]; });
    if (Object.keys(fieldUpdates).length === 0) return res.status(400).json({ error: 'No updatable fields provided' });
    const access = await requirePodMember(podId || '', userId, { write: true });
    if (access.error) return res.status(access.status || 500).json({ error: access.error });
    const author = await resolveAuthor(req);
    const changeParts: string[] = [];
    if (fieldUpdates.assignee !== undefined) changeParts.push(`reassigned to ${fieldUpdates.assignee || 'unassigned'}`);
    if (fieldUpdates.assigneeType !== undefined) changeParts.push(`assignee type → ${fieldUpdates.assigneeType || 'none'}`);
    if (fieldUpdates.status !== undefined) changeParts.push(`status → ${fieldUpdates.status}`);
    if (fieldUpdates.dep !== undefined) changeParts.push(`dep → ${fieldUpdates.dep || 'none'}`);
    if (fieldUpdates.parentTask !== undefined) changeParts.push(`parent → ${fieldUpdates.parentTask || 'none'}`);
    if (fieldUpdates.prUrl !== undefined) changeParts.push(`PR: ${fieldUpdates.prUrl}`);
    if (fieldUpdates.notes !== undefined) changeParts.push('notes updated');
    if (fieldUpdates.title !== undefined) changeParts.push('title updated');
    if (fieldUpdates.progressPercent !== undefined) changeParts.push(`progress → ${fieldUpdates.progressPercent}%`);
    if (fieldUpdates.blocker !== undefined) {
      const blocker = fieldUpdates.blocker as { open?: boolean };
      changeParts.push(blocker?.open ? 'blocker raised' : 'blocker cleared');
    }
    const update: Record<string, unknown> = { $set: fieldUpdates };
    if (changeParts.length > 0) update.$push = { updates: { text: `${author} updated: ${changeParts.join(', ')}`, author, authorId: userId?.toString() || null, createdAt: new Date() } };
    const task = await Task.findOneAndUpdate({ podId: mongoose.Types.ObjectId.createFromHexString(podId || ''), taskId }, update, { new: true });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    emitTaskUpdated(podId, task, 'updated');
    if (fieldUpdates.assignee !== undefined || fieldUpdates.assigneeRef !== undefined || fieldUpdates.assigneeType !== undefined) {
      await enqueueTaskAssignedIfNeeded({
        podId,
        task: task.toObject ? task.toObject() : task,
      });
    }
    return res.json({ task });
  } catch (err) {
    console.error('PATCH /tasks error:', err);
    return res.status(500).json({ error: 'Failed to update task' });
  }
});

module.exports = router;

export {};
