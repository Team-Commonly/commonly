// @ts-nocheck
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const auth = require('../../middleware/auth');
const adminAuth = require('../../middleware/adminAuth');
const User = require('../../models/User');
const InvitationCode = require('../../models/InvitationCode');
const WaitlistRequest = require('../../models/WaitlistRequest');

const router = express.Router();

const sanitizeUser = (user) => ({
  id: user._id?.toString?.() || user.id,
  username: user.username,
  email: user.email,
  role: user.role,
  verified: Boolean(user.verified),
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

const sanitizeInvitation = (invite) => ({
  id: invite._id?.toString?.() || invite.id,
  code: invite.code,
  note: invite.note || '',
  maxUses: invite.maxUses,
  useCount: invite.useCount,
  isActive: Boolean(invite.isActive),
  expiresAt: invite.expiresAt || null,
  lastUsedAt: invite.lastUsedAt || null,
  createdAt: invite.createdAt || null,
  createdBy: invite.createdBy
    ? {
      id: invite.createdBy._id?.toString?.() || invite.createdBy.id || null,
      username: invite.createdBy.username || '',
      email: invite.createdBy.email || '',
    }
    : null,
});

const sanitizeWaitlist = (request) => ({
  id: request._id?.toString?.() || request.id,
  email: request.email,
  name: request.name || '',
  organization: request.organization || '',
  useCase: request.useCase || '',
  note: request.note || '',
  status: request.status || 'pending',
  createdAt: request.createdAt || null,
  updatedAt: request.updatedAt || null,
  invitedAt: request.invitedAt || null,
  invitationSentAt: request.invitationSentAt || null,
  invitationCode: request.invitationCode
    ? {
      id: request.invitationCode._id?.toString?.() || request.invitationCode.id || null,
      code: request.invitationCode.code || '',
    }
    : null,
  invitedBy: request.invitedBy
    ? {
      id: request.invitedBy._id?.toString?.() || request.invitedBy.id || null,
      username: request.invitedBy.username || '',
      email: request.invitedBy.email || '',
    }
    : null,
});

const generateInvitationCode = () => `CM-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
const SMTP2GO_BASE_URL = process.env.SMTP2GO_BASE_URL || 'https://api.smtp2go.com/v3';
const SMTP2GO_SEND_URL = `${SMTP2GO_BASE_URL.replace(/\/$/, '')}/email/send`;

const getPrimaryFrontendUrl = () => {
  const raw = String(process.env.FRONTEND_URL || '').trim();
  if (!raw) return 'https://app.commonly.me';
  return raw.split(',').map((value) => value.trim()).filter(Boolean)[0] || 'https://app.commonly.me';
};

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
};

// GET /api/admin/users
router.get('/', auth, adminAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const role = String(req.query.role || 'all').trim().toLowerCase();
    const query = {};

    if (q) {
      query.$or = [
        { username: { $regex: q, $options: 'i' } },
        { email: { $regex: q, $options: 'i' } },
      ];
    }
    if (role === 'admin' || role === 'user') {
      query.role = role;
    }

    const users = await User.find(query)
      .select('username email role verified createdAt updatedAt')
      .sort({ createdAt: -1 })
      .lean();

    return res.json({
      users: users.map(sanitizeUser),
      total: users.length,
    });
  } catch (error) {
    console.error('Failed to list users:', error);
    return res.status(500).json({ error: 'Failed to list users' });
  }
});

// PATCH /api/admin/users/:userId/role
router.patch('/:userId/role', auth, adminAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const { role } = req.body || {};
    const nextRole = String(role || '').trim().toLowerCase();
    if (!['admin', 'user'].includes(nextRole)) {
      return res.status(400).json({ error: 'Role must be either "admin" or "user"' });
    }
    if (req.user?.id && String(req.user.id) === String(userId)) {
      return res.status(400).json({ error: 'You cannot change your own admin role' });
    }

    const target = await User.findById(userId);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (target.role === 'admin' && nextRole === 'user') {
      const adminCount = await User.countDocuments({ role: 'admin' });
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'Cannot remove the last global admin' });
      }
    }

    target.role = nextRole;
    await target.save();

    return res.json({
      message: 'User role updated successfully',
      user: sanitizeUser(target),
    });
  } catch (error) {
    console.error('Failed to update user role:', error);
    return res.status(500).json({ error: 'Failed to update user role' });
  }
});

// DELETE /api/admin/users/:userId
router.delete('/:userId', auth, adminAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    if (req.user?.id && String(req.user.id) === String(userId)) {
      return res.status(400).json({ error: 'You cannot delete your own account from admin tools' });
    }

    const target = await User.findById(userId);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (target.isBot) {
      return res.status(400).json({ error: 'Bot accounts cannot be deleted from this endpoint' });
    }

    if (target.role === 'admin') {
      const adminCount = await User.countDocuments({ role: 'admin' });
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last global admin' });
      }
    }

    await target.deleteOne();
    return res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Failed to delete user:', error);
    return res.status(500).json({ error: 'Failed to delete user' });
  }
});

// GET /api/admin/users/invitations
router.get('/invitations', auth, adminAuth, async (req, res) => {
  try {
    const page = parsePositiveInt(req.query.page, 1);
    const requestedLimit = parsePositiveInt(req.query.limit, 20);
    const limit = Math.min(requestedLimit, 100);
    const skip = (page - 1) * limit;
    const filter = {};

    const [invites, total] = await Promise.all([
      InvitationCode.find(filter)
        .populate('createdBy', 'username email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      InvitationCode.countDocuments(filter),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / limit));
    return res.json({
      invitations: invites.map(sanitizeInvitation),
      total,
      page,
      limit,
      totalPages,
    });
  } catch (error) {
    console.error('Failed to list invitation codes:', error);
    return res.status(500).json({ error: 'Failed to list invitation codes' });
  }
});

// POST /api/admin/users/invitations
router.post('/invitations', auth, adminAuth, async (req, res) => {
  try {
    const {
      code: requestedCode,
      note = '',
      maxUses = 1,
      expiresAt = null,
    } = req.body || {};

    const code = String(requestedCode || generateInvitationCode()).trim().toUpperCase();
    if (!code) {
      return res.status(400).json({ error: 'Invitation code cannot be empty' });
    }
    const parsedMaxUses = Number(maxUses);
    if (!Number.isFinite(parsedMaxUses) || parsedMaxUses < 1) {
      return res.status(400).json({ error: 'maxUses must be a number >= 1' });
    }

    const expiresDate = expiresAt ? new Date(expiresAt) : null;
    if (expiresDate && Number.isNaN(expiresDate.getTime())) {
      return res.status(400).json({ error: 'expiresAt must be a valid date' });
    }

    const existing = await InvitationCode.findOne({ code });
    if (existing) {
      return res.status(409).json({ error: 'Invitation code already exists' });
    }

    const created = await InvitationCode.create({
      code,
      note: String(note || '').trim(),
      maxUses: parsedMaxUses,
      useCount: 0,
      isActive: true,
      expiresAt: expiresDate,
      createdBy: req.user.id,
    });

    const hydrated = await InvitationCode.findById(created._id)
      .populate('createdBy', 'username email')
      .lean();

    return res.status(201).json({
      message: 'Invitation code created',
      invitation: sanitizeInvitation(hydrated),
    });
  } catch (error) {
    console.error('Failed to create invitation code:', error);
    return res.status(500).json({ error: 'Failed to create invitation code' });
  }
});

// POST /api/admin/users/invitations/:invitationId/revoke
router.post('/invitations/:invitationId/revoke', auth, adminAuth, async (req, res) => {
  try {
    const invitation = await InvitationCode.findByIdAndUpdate(
      req.params.invitationId,
      { $set: { isActive: false } },
      { new: true },
    ).populate('createdBy', 'username email');

    if (!invitation) {
      return res.status(404).json({ error: 'Invitation code not found' });
    }

    return res.json({
      message: 'Invitation code revoked',
      invitation: sanitizeInvitation(invitation),
    });
  } catch (error) {
    console.error('Failed to revoke invitation code:', error);
    return res.status(500).json({ error: 'Failed to revoke invitation code' });
  }
});

// GET /api/admin/users/waitlist
router.get('/waitlist', auth, adminAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const status = String(req.query.status || 'all').trim().toLowerCase();
    const page = parsePositiveInt(req.query.page, 1);
    const requestedLimit = parsePositiveInt(req.query.limit, 20);
    const limit = Math.min(requestedLimit, 100);
    const skip = (page - 1) * limit;
    const query = {};

    if (q) {
      query.$or = [
        { email: { $regex: q, $options: 'i' } },
        { name: { $regex: q, $options: 'i' } },
        { organization: { $regex: q, $options: 'i' } },
      ];
    }
    if (['pending', 'invited', 'closed'].includes(status)) {
      query.status = status;
    }

    const [requests, total] = await Promise.all([
      WaitlistRequest.find(query)
        .populate('invitationCode', 'code')
        .populate('invitedBy', 'username email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      WaitlistRequest.countDocuments(query),
    ]);
    const totalPages = Math.max(1, Math.ceil(total / limit));

    return res.json({
      requests: requests.map(sanitizeWaitlist),
      total,
      page,
      limit,
      totalPages,
    });
  } catch (error) {
    console.error('Failed to list waitlist requests:', error);
    return res.status(500).json({ error: 'Failed to list waitlist requests' });
  }
});

// PATCH /api/admin/users/waitlist/:requestId
router.patch('/waitlist/:requestId', auth, adminAuth, async (req, res) => {
  try {
    const status = String(req.body?.status || '').trim().toLowerCase();
    if (!['pending', 'invited', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'status must be one of pending, invited, or closed' });
    }

    const update = { status };
    if (status === 'closed') {
      update.invitedAt = null;
      update.invitationSentAt = null;
      update.invitationCode = null;
      update.invitedBy = null;
    }

    const request = await WaitlistRequest.findByIdAndUpdate(
      req.params.requestId,
      { $set: update },
      { new: true },
    )
      .populate('invitationCode', 'code')
      .populate('invitedBy', 'username email');

    if (!request) {
      return res.status(404).json({ error: 'Waitlist request not found' });
    }

    return res.json({
      message: 'Waitlist request updated',
      request: sanitizeWaitlist(request),
    });
  } catch (error) {
    console.error('Failed to update waitlist request:', error);
    return res.status(500).json({ error: 'Failed to update waitlist request' });
  }
});

// POST /api/admin/users/waitlist/:requestId/send-invitation
router.post('/waitlist/:requestId/send-invitation', auth, adminAuth, async (req, res) => {
  try {
    const waitlistRequest = await WaitlistRequest.findById(req.params.requestId);
    if (!waitlistRequest) {
      return res.status(404).json({ error: 'Waitlist request not found' });
    }

    const smtpConfigured = Boolean(process.env.SMTP2GO_API_KEY)
      && Boolean(process.env.SMTP2GO_FROM_EMAIL);
    if (!smtpConfigured) {
      return res.status(503).json({
        error: 'SMTP is not configured. Configure SMTP2GO before sending invitation emails.',
      });
    }

    const {
      invitationId = null,
      code: requestedCode = '',
      maxUses = 1,
      expiresAt = null,
    } = req.body || {};
    const now = new Date();
    let invitation = null;

    if (invitationId) {
      invitation = await InvitationCode.findById(invitationId);
      if (!invitation) {
        return res.status(404).json({ error: 'Invitation code not found' });
      }
      if (!invitation.isActive) {
        return res.status(400).json({ error: 'Invitation code is not active' });
      }
      if (invitation.expiresAt && invitation.expiresAt <= now) {
        return res.status(400).json({ error: 'Invitation code is expired' });
      }
      if (Number(invitation.useCount) >= Number(invitation.maxUses)) {
        return res.status(400).json({ error: 'Invitation code has no remaining uses' });
      }
    } else {
      const code = String(requestedCode || generateInvitationCode()).trim().toUpperCase();
      const parsedMaxUses = Number(maxUses);
      if (!code) {
        return res.status(400).json({ error: 'Invitation code cannot be empty' });
      }
      if (!Number.isFinite(parsedMaxUses) || parsedMaxUses < 1) {
        return res.status(400).json({ error: 'maxUses must be a number >= 1' });
      }
      const expiresDate = expiresAt ? new Date(expiresAt) : null;
      if (expiresDate && Number.isNaN(expiresDate.getTime())) {
        return res.status(400).json({ error: 'expiresAt must be a valid date' });
      }
      const existing = await InvitationCode.findOne({ code });
      if (existing) {
        return res.status(409).json({ error: 'Invitation code already exists' });
      }

      invitation = await InvitationCode.create({
        code,
        note: `waitlist:${waitlistRequest.email}`,
        maxUses: parsedMaxUses,
        useCount: 0,
        isActive: true,
        expiresAt: expiresDate,
        createdBy: req.user.id,
      });
    }

    const frontendUrl = getPrimaryFrontendUrl();
    const registerUrl = `${frontendUrl.replace(/\/$/, '')}/register?invite=${encodeURIComponent(invitation.code)}`;
    const recipientName = waitlistRequest.name || 'there';
    const subject = 'Your Commonly invitation code';
    const textBody = [
      `Hi ${recipientName},`,
      '',
      'Your waitlist request has been approved.',
      `Invitation code: ${invitation.code}`,
      '',
      `Complete registration: ${registerUrl}`,
    ].join('\n');
    const htmlBody = [
      `<p>Hi ${recipientName},</p>`,
      '<p>Your waitlist request has been approved.</p>',
      `<p><strong>Invitation code:</strong> ${invitation.code}</p>`,
      `<p><a href="${registerUrl}">Complete registration</a></p>`,
    ].join('');

    await axios.post(SMTP2GO_SEND_URL, {
      api_key: process.env.SMTP2GO_API_KEY,
      to: [waitlistRequest.email],
      sender: process.env.SMTP2GO_FROM_EMAIL,
      from_name: process.env.SMTP2GO_FROM_NAME || 'Commonly',
      subject,
      text_body: textBody,
      html_body: htmlBody,
    }, { timeout: 30000 });

    waitlistRequest.status = 'invited';
    waitlistRequest.invitationCode = invitation._id;
    waitlistRequest.invitedAt = now;
    waitlistRequest.invitationSentAt = now;
    waitlistRequest.invitedBy = req.user.id;
    await waitlistRequest.save();

    const hydrated = await WaitlistRequest.findById(waitlistRequest._id)
      .populate('invitationCode', 'code')
      .populate('invitedBy', 'username email')
      .lean();

    return res.json({
      message: 'Invitation email sent',
      invitation: sanitizeInvitation(invitation),
      request: sanitizeWaitlist(hydrated),
    });
  } catch (error) {
    console.error('Failed to send waitlist invitation email:', error?.response?.data || error);
    return res.status(500).json({ error: 'Failed to send invitation email' });
  }
});

module.exports = router;
