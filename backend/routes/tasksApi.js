const express = require('express');
const mongoose = require('mongoose');
const regularAuth = require('../middleware/auth');
const agentRuntimeAuth = require('../middleware/agentRuntimeAuth');
const Pod = require('../models/Pod');
const Task = require('../models/Task');
const User = require('../models/User');
const GitHubAppService = require('../services/githubAppService');

/**
 * Accept both agent runtime tokens (cm_agent_*) and regular JWT/API tokens.
 */
function auth(req, res, next) {
  const token = (req.header('Authorization') || '').replace('Bearer ', '');
  if (token.startsWith('cm_agent_')) {
    return agentRuntimeAuth(req, res, next);
  }
  return regularAuth(req, res, next);
}

const router = express.Router();

/**
 * Resolve a display name for the caller (for update author field).
 */
async function resolveAuthor(req) {
  const agentInstance = req.user?.isBot
    ? (req.user.botMetadata?.instanceId || req.user.botMetadata?.agentName)
    : null;
  if (agentInstance) return agentInstance;

  // Human user: look up username
  const userId = req.userId || req.user?._id || req.user?.id || req.agentUser?._id;
  if (userId) {
    const u = await User.findById(userId).select('username').lean();
    if (u?.username) return u.username;
  }
  return 'unknown';
}

/**
 * Resolve agent instanceId from authenticated request.
 * Returns instanceId string (e.g. "nova") or null for human users.
 */
function resolveAgentInstanceId(req) {
  const user = req.user;
  if (!user?.isBot) return null;
  return user.botMetadata?.instanceId || user.botMetadata?.agentName || null;
}

/**
 * Verify the caller is a member of the pod (any role except viewer for writes).
 */
async function requirePodMember(podId, userId, { write = false } = {}) {
  const pod = await Pod.findById(podId).lean();
  if (!pod) return { error: 'Pod not found', status: 404 };
  const membership = pod.members?.find((m) => {
    if (!m) return false;
    const id = m.userId ? m.userId.toString() : m.toString();
    return id === userId.toString();
  });
  if (!membership) return { error: 'Access denied', status: 403 };
  if (write && membership.role === 'viewer') return { error: 'Write access denied', status: 403 };
  return { pod };
}

/**
 * Generate the next taskId for a pod ("TASK-001", "TASK-002", ...).
 * Not perfectly atomic but Theo is the only creator — good enough.
 */
async function nextTaskId(podId) {
  const count = await Task.countDocuments({ podId });
  const num = count + 1;
  return { taskId: `TASK-${String(num).padStart(3, '0')}`, taskNum: num };
}

/**
 * GET /api/v1/tasks/:podId
 * List tasks. Optional query: ?assignee=nova&status=pending
 */
router.get('/:podId', auth, async (req, res) => {
  try {
    const { podId } = req.params;
    const userId = req.userId || req.user?._id || req.agentUser?._id;
    const { assignee, status } = req.query;

    const access = await requirePodMember(podId, userId);
    if (access.error) return res.status(access.status).json({ error: access.error });

    const query = { podId: mongoose.Types.ObjectId.createFromHexString(podId) };
    if (assignee) query.assignee = assignee;
    if (status) query.status = status.includes(',') ? { $in: status.split(',') } : status;

    const tasks = await Task.find(query).sort({ taskNum: 1 }).lean();
    return res.json({ tasks });
  } catch (err) {
    console.error('GET /tasks error:', err);
    return res.status(500).json({ error: 'Failed to list tasks' });
  }
});

/**
 * POST /api/v1/tasks/:podId
 * Create a task. Body: { title, assignee?, dep?, depMockOk?, source?, sourceRef?,
 *                        githubIssueNumber?, githubIssueUrl?, createGithubIssue? }
 *
 * Dedup: if sourceRef is provided and a task with that sourceRef already exists in this pod,
 * returns the existing task with { task, alreadyExists: true } — no duplicate created.
 *
 * createGithubIssue: true — creates a GH issue from the task (board→GitHub direction).
 */
router.post('/:podId', auth, async (req, res) => {
  try {
    const { podId } = req.params;
    const userId = req.userId || req.user?._id || req.agentUser?._id;
    const {
      title, assignee, dep, depMockOk, parentTask, source, sourceRef,
      githubIssueNumber, githubIssueUrl, createGithubIssue,
    } = req.body;

    if (!title) return res.status(400).json({ error: 'title is required' });

    const access = await requirePodMember(podId, userId, { write: true });
    if (access.error) return res.status(access.status).json({ error: access.error });

    // Dedup: don't create a second task for the same GitHub issue.
    // Exception: if the existing task is 'done', reset it to 'pending' so the
    // issue gets picked up again (e.g. PR was closed without merging).
    if (sourceRef) {
      const existing = await Task.findOne({
        podId: mongoose.Types.ObjectId.createFromHexString(podId),
        sourceRef,
      });
      if (existing) {
        if (existing.status === 'done') {
          existing.status = 'pending';
          existing.assignee = assignee || null;
          existing.claimedAt = null;
          existing.notes = 'Reopened — previously completed but issue is still open.';
          existing.updates.push({
            text: 'Reopened: task was done but linked issue is still open — picking up again.',
            author: 'system',
            authorId: null,
            createdAt: new Date(),
          });
          await existing.save();
          return res.json({ task: existing.toObject(), alreadyExists: false, reopened: true });
        }
        return res.json({ task: existing.toObject(), alreadyExists: true });
      }
    }

    // Board → GitHub: optionally create a GH issue so humans can track it there too
    let ghNumber = githubIssueNumber || null;
    let ghUrl = githubIssueUrl || null;
    if (createGithubIssue && title && GitHubAppService.isPatConfigured()) {
      try {
        const bodyParts = [];
        if (assignee) bodyParts.push(`Assigned to: ${assignee}`);
        if (parentTask) bodyParts.push(`Parent task: ${parentTask}`);
        if (dep) bodyParts.push(`Blocked by: ${dep}`);
        const issue = await GitHubAppService.createIssue({ title, body: bodyParts.join('\n') || undefined });
        ghNumber = issue.number;
        ghUrl = issue.html_url;
      } catch (ghErr) {
        console.warn('createGithubIssue failed (non-fatal):', ghErr.message);
      }
    }

    const author = await resolveAuthor(req);
    const { taskId, taskNum } = await nextTaskId(podId);

    const initUpdate = { text: `Created by ${author}`, author, authorId: userId?.toString() || null, createdAt: new Date() };
    if (assignee) initUpdate.text = `Created by ${author} · assigned to ${assignee}`;
    if (sourceRef) initUpdate.text = `Created by ${author} from ${sourceRef}${assignee ? ` · assigned to ${assignee}` : ''}`;
    if (ghNumber) initUpdate.text += ` · GH#${ghNumber}`;
    if (parentTask) initUpdate.text += ` · sub-task of ${parentTask}`;

    const task = await Task.create({
      podId,
      taskNum,
      taskId,
      title,
      assignee: assignee || null,
      dep: dep || null,
      depMockOk: !!depMockOk,
      parentTask: parentTask || null,
      source: source || (ghNumber ? 'github' : 'human'),
      sourceRef: sourceRef || (ghNumber ? `GH#${ghNumber}` : undefined),
      githubIssueNumber: ghNumber,
      githubIssueUrl: ghUrl,
      updates: [initUpdate],
    });

    // If this sub-task has a parent that links to a GH issue, comment there
    if (parentTask && GitHubAppService.isPatConfigured()) {
      try {
        const parent = await Task.findOne({
          podId: mongoose.Types.ObjectId.createFromHexString(podId),
          taskId: parentTask,
        }).lean();
        if (parent?.githubIssueNumber) {
          const depNote = dep ? ` (blocked by ${dep})` : '';
          GitHubAppService.addIssueComment({
            issueNumber: parent.githubIssueNumber,
            comment: `**Sub-task created:** ${taskId} — ${title}${depNote}\nAssigned to: ${assignee || 'unassigned'}`,
          }).catch((e) => console.warn('GH sub-task comment failed:', e.message));
        }
      } catch (e) {
        console.warn('Parent GH lookup failed (non-fatal):', e.message);
      }
    }

    return res.status(201).json({ task });
  } catch (err) {
    console.error('POST /tasks error:', err);
    return res.status(500).json({ error: 'Failed to create task' });
  }
});

/**
 * POST /api/v1/tasks/:podId/:taskId/claim
 * Atomically claim a pending task. Only one agent wins.
 */
router.post('/:podId/:taskId/claim', auth, async (req, res) => {
  try {
    const { podId, taskId } = req.params;
    const userId = req.userId || req.user?._id || req.agentUser?._id;
    const agentId = resolveAgentInstanceId(req);
    const claimedBy = agentId || userId.toString();

    const access = await requirePodMember(podId, userId, { write: true });
    if (access.error) return res.status(access.status).json({ error: access.error });

    const update = { $set: { status: 'claimed', claimedBy, claimedAt: new Date() }, $push: { updates: { text: `Claimed by ${claimedBy}`, author: claimedBy, authorId: userId?.toString() || null, createdAt: new Date() } } };

    // Atomic: only succeeds if task is still pending
    const task = await Task.findOneAndUpdate(
      { podId: mongoose.Types.ObjectId.createFromHexString(podId), taskId, status: 'pending' },
      update,
      { new: true },
    );

    if (!task) {
      const existing = await Task.findOne({ podId: mongoose.Types.ObjectId.createFromHexString(podId), taskId }).lean();
      if (!existing) return res.status(404).json({ error: 'Task not found' });
      return res.status(409).json({ error: 'Task already claimed', claimedBy: existing.claimedBy, status: existing.status });
    }

    return res.json({ task });
  } catch (err) {
    console.error('POST /tasks/claim error:', err);
    return res.status(500).json({ error: 'Failed to claim task' });
  }
});

/**
 * POST /api/v1/tasks/:podId/:taskId/complete
 * Mark a claimed task as done. Body: { prUrl?, notes? }
 */
router.post('/:podId/:taskId/complete', auth, async (req, res) => {
  try {
    const { podId, taskId } = req.params;
    const userId = req.userId || req.user?._id || req.agentUser?._id;
    const { prUrl, notes } = req.body;
    const author = await resolveAuthor(req);

    const access = await requirePodMember(podId, userId, { write: true });
    if (access.error) return res.status(access.status).json({ error: access.error });

    const updateText = prUrl ? `Completed by ${author} · PR: ${prUrl}` : `Completed by ${author}`;
    const update = {
      $set: { status: 'done', completedAt: new Date(), ...(prUrl && { prUrl }), ...(notes && { notes }) },
      $push: { updates: { text: updateText, author, authorId: userId?.toString() || null, createdAt: new Date() } },
    };

    const task = await Task.findOneAndUpdate(
      { podId: mongoose.Types.ObjectId.createFromHexString(podId), taskId, status: { $in: ['claimed', 'pending'] } },
      update,
      { new: true },
    );

    if (!task) {
      const existing = await Task.findOne({ podId: mongoose.Types.ObjectId.createFromHexString(podId), taskId }).lean();
      if (!existing) return res.status(404).json({ error: 'Task not found' });
      return res.status(409).json({ error: 'Task is already done', status: existing.status });
    }

    // Note: GitHub issue closing is intentionally NOT done here.
    // Agents close issues autonomously via acpx_run (gh CLI) after confirming PR is merged.

    return res.json({ task });
  } catch (err) {
    console.error('POST /tasks/complete error:', err);
    return res.status(500).json({ error: 'Failed to complete task' });
  }
});

/**
 * POST /api/v1/tasks/:podId/:taskId/updates
 * Append a freeform update entry (progress note, comment, blocker reason).
 * Body: { text }
 */
router.post('/:podId/:taskId/updates', auth, async (req, res) => {
  try {
    const { podId, taskId } = req.params;
    const userId = req.userId || req.user?._id || req.agentUser?._id;
    const { text } = req.body;

    if (!text?.trim()) return res.status(400).json({ error: 'text is required' });

    const access = await requirePodMember(podId, userId, { write: true });
    if (access.error) return res.status(access.status).json({ error: access.error });

    const author = await resolveAuthor(req);

    const task = await Task.findOneAndUpdate(
      { podId: mongoose.Types.ObjectId.createFromHexString(podId), taskId },
      { $push: { updates: { text: text.trim(), author, authorId: userId?.toString() || null, createdAt: new Date() } } },
      { new: true },
    );

    if (!task) return res.status(404).json({ error: 'Task not found' });
    return res.json({ task });
  } catch (err) {
    console.error('POST /tasks/updates error:', err);
    return res.status(500).json({ error: 'Failed to add update' });
  }
});

/**
 * PATCH /api/v1/tasks/:podId/:taskId
 * Update task fields (reassign, add notes, change status, etc.)
 * Body: { title?, assignee?, dep?, depMockOk?, status?, notes?, prUrl? }
 */
router.patch('/:podId/:taskId', auth, async (req, res) => {
  try {
    const { podId, taskId } = req.params;
    const userId = req.userId || req.user?._id || req.agentUser?._id;
    const allowed = ['title', 'assignee', 'dep', 'depMockOk', 'parentTask', 'status', 'notes', 'prUrl'];
    const fieldUpdates = {};
    allowed.forEach((k) => {
      if (req.body[k] !== undefined) fieldUpdates[k] = req.body[k];
    });

    if (Object.keys(fieldUpdates).length === 0) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }

    const access = await requirePodMember(podId, userId, { write: true });
    if (access.error) return res.status(access.status).json({ error: access.error });

    const author = await resolveAuthor(req);

    // Build a human-readable summary of what changed for the updates log
    const changeParts = [];
    if (fieldUpdates.assignee !== undefined) changeParts.push(`reassigned to ${fieldUpdates.assignee || 'unassigned'}`);
    if (fieldUpdates.status !== undefined) changeParts.push(`status → ${fieldUpdates.status}`);
    if (fieldUpdates.dep !== undefined) changeParts.push(`dep → ${fieldUpdates.dep || 'none'}`);
    if (fieldUpdates.parentTask !== undefined) changeParts.push(`parent → ${fieldUpdates.parentTask || 'none'}`);
    if (fieldUpdates.prUrl !== undefined) changeParts.push(`PR: ${fieldUpdates.prUrl}`);
    if (fieldUpdates.notes !== undefined) changeParts.push('notes updated');
    if (fieldUpdates.title !== undefined) changeParts.push('title updated');

    const update = { $set: fieldUpdates };
    if (changeParts.length > 0) {
      update.$push = { updates: { text: `${author} updated: ${changeParts.join(', ')}`, author, authorId: userId?.toString() || null, createdAt: new Date() } };
    }

    const task = await Task.findOneAndUpdate(
      { podId: mongoose.Types.ObjectId.createFromHexString(podId), taskId },
      update,
      { new: true },
    );

    if (!task) return res.status(404).json({ error: 'Task not found' });
    return res.json({ task });
  } catch (err) {
    console.error('PATCH /tasks error:', err);
    return res.status(500).json({ error: 'Failed to update task' });
  }
});

module.exports = router;
