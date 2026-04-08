// @ts-nocheck
const express = require('express');
const auth = require('../../middleware/auth');
const adminAuth = require('../../middleware/adminAuth');
const AgentEvent = require('../../models/AgentEvent');
const { AgentInstallation } = require('../../models/AgentRegistry');

const router = express.Router();

const toPositiveInt = (value, fallback, { min = 1, max = 500 } = {}) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

router.get('/', auth, adminAuth, async (req, res) => {
  try {
    const limitPending = toPositiveInt(req.query.limitPending, 100);
    const limitRecent = toPositiveInt(req.query.limitRecent, 100);
    const stalePendingMinutes = toPositiveInt(
      req.query.stalePendingMinutes,
      Number(process.env.AGENT_EVENT_STALE_PENDING_MINUTES || 30),
      { min: 1, max: 1440 },
    );
    const staleThreshold = new Date(Date.now() - stalePendingMinutes * 60 * 1000);

    const [
      statusCountsRaw,
      deliveredByOutcomeRaw,
      pendingByAgent,
      pendingEventsRaw,
      recentEventsRaw,
      failedByAgentRaw,
      failedEventsRaw,
      stalePendingCount,
      installations,
      lastHeartbeatByInstallation,
    ] = await Promise.all([
      AgentEvent.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      AgentEvent.aggregate([
        { $match: { status: 'delivered' } },
        {
          $group: {
            _id: { $ifNull: ['$delivery.outcome', 'acknowledged'] },
            count: { $sum: 1 },
          },
        },
      ]),
      AgentEvent.aggregate([
        { $match: { status: 'pending' } },
        {
          $group: {
            _id: {
              agentName: '$agentName',
              instanceId: '$instanceId',
            },
            count: { $sum: 1 },
            oldestCreatedAt: { $min: '$createdAt' },
            newestCreatedAt: { $max: '$createdAt' },
          },
        },
        { $sort: { count: -1 } },
        { $limit: 50 },
      ]),
      AgentEvent.find({ status: 'pending' })
        .sort({ createdAt: 1 })
        .limit(limitPending)
        .lean(),
      AgentEvent.find({})
        .sort({ createdAt: -1 })
        .limit(limitRecent)
        .lean(),
      AgentEvent.aggregate([
        { $match: { status: 'failed' } },
        { $sort: { createdAt: 1 } },
        {
          $group: {
            _id: {
              agentName: '$agentName',
              instanceId: '$instanceId',
            },
            count: { $sum: 1 },
            oldestCreatedAt: { $min: '$createdAt' },
            newestCreatedAt: { $max: '$createdAt' },
            newestError: { $last: '$error' },
          },
        },
        { $sort: { count: -1, newestCreatedAt: -1 } },
        { $limit: 50 },
      ]),
      AgentEvent.find({ status: 'failed' })
        .sort({ createdAt: -1 })
        .limit(limitRecent)
        .lean(),
      AgentEvent.countDocuments({
        status: 'pending',
        createdAt: { $lt: staleThreshold },
      }),
      AgentInstallation.find({ status: 'active' })
        .select('agentName instanceId podId status config.heartbeat.everyMinutes')
        .lean(),
      AgentEvent.aggregate([
        { $match: { type: 'heartbeat' } },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: {
              agentName: '$agentName',
              instanceId: '$instanceId',
              podId: '$podId',
            },
            eventId: { $first: '$_id' },
            createdAt: { $first: '$createdAt' },
            deliveredAt: { $first: '$deliveredAt' },
            status: { $first: '$status' },
            trigger: { $first: '$payload.trigger' },
          },
        },
      ]),
    ]);

    const statusCounts = statusCountsRaw.reduce((acc, row) => {
      if (row?._id) acc[row._id] = row.count || 0;
      return acc;
    }, {});
    const deliveredByOutcome = deliveredByOutcomeRaw.reduce((acc, row) => {
      if (row?._id) acc[row._id] = row.count || 0;
      return acc;
    }, {});

    const pendingEvents = pendingEventsRaw.map((event) => ({
      id: String(event._id),
      agentName: event.agentName,
      instanceId: event.instanceId || 'default',
      podId: String(event.podId),
      type: event.type,
      status: event.status,
      attempts: event.attempts || 0,
      createdAt: event.createdAt,
      payload: event.payload || {},
      error: event.error || null,
    }));

    const recentEvents = recentEventsRaw.map((event) => ({
      id: String(event._id),
      agentName: event.agentName,
      instanceId: event.instanceId || 'default',
      podId: String(event.podId),
      type: event.type,
      status: event.status,
      attempts: event.attempts || 0,
      createdAt: event.createdAt,
      deliveredAt: event.deliveredAt || null,
      payload: event.payload || {},
      delivery: event.delivery || null,
      error: event.error || null,
    }));

    const lastHeartbeatMap = new Map(
      lastHeartbeatByInstallation.map((row) => ([
        `${row?._id?.agentName || ''}:${row?._id?.instanceId || 'default'}:${row?._id?.podId || ''}`,
        row,
      ])),
    );

    const installationHeartbeatStatus = installations.map((installation) => {
      const key = `${installation.agentName}:${installation.instanceId || 'default'}:${installation.podId}`;
      const last = lastHeartbeatMap.get(key);
      const everyMinutesRaw = Number(installation?.config?.heartbeat?.everyMinutes);
      const everyMinutes = Number.isFinite(everyMinutesRaw) && everyMinutesRaw > 0
        ? Math.min(1440, Math.max(1, Math.trunc(everyMinutesRaw)))
        : 60;
      return {
        agentName: installation.agentName,
        instanceId: installation.instanceId || 'default',
        podId: String(installation.podId),
        everyMinutes,
        lastHeartbeatEventId: last?.eventId ? String(last.eventId) : null,
        lastHeartbeatAt: last?.createdAt || null,
        lastHeartbeatDeliveredAt: last?.deliveredAt || null,
        lastHeartbeatStatus: last?.status || null,
        lastHeartbeatTrigger: last?.trigger || null,
      };
    });

    res.json({
      generatedAt: new Date().toISOString(),
      queue: {
        total: (statusCounts.pending || 0) + (statusCounts.delivered || 0) + (statusCounts.failed || 0),
        pending: statusCounts.pending || 0,
        delivered: statusCounts.delivered || 0,
        deliveredByOutcome,
        failed: statusCounts.failed || 0,
        stalePendingMinutes,
        stalePendingCount,
      },
      pendingByAgent: pendingByAgent.map((row) => ({
        agentName: row?._id?.agentName || null,
        instanceId: row?._id?.instanceId || 'default',
        count: row.count || 0,
        oldestCreatedAt: row.oldestCreatedAt || null,
        newestCreatedAt: row.newestCreatedAt || null,
      })),
      pendingEvents,
      failedByAgent: failedByAgentRaw.map((row) => ({
        agentName: row?._id?.agentName || null,
        instanceId: row?._id?.instanceId || 'default',
        count: row.count || 0,
        oldestCreatedAt: row.oldestCreatedAt || null,
        newestCreatedAt: row.newestCreatedAt || null,
        newestError: row.newestError || null,
      })),
      failedEvents: failedEventsRaw.map((event) => ({
        id: String(event._id),
        agentName: event.agentName,
        instanceId: event.instanceId || 'default',
        podId: String(event.podId),
        type: event.type,
        status: event.status,
        attempts: event.attempts || 0,
        createdAt: event.createdAt,
        deliveredAt: event.deliveredAt || null,
        payload: event.payload || {},
        error: event.error || null,
      })),
      recentEvents,
      recentDeliveredHeartbeats: recentEvents
        .filter((event) => event.type === 'heartbeat' && event.status === 'delivered')
        .slice(0, 60)
        .map((event) => ({
          id: String(event._id),
          agentName: event.agentName,
          instanceId: event.instanceId || 'default',
          podId: String(event.podId),
          type: event.type,
          createdAt: event.createdAt,
          deliveredAt: event.deliveredAt || null,
          attempts: event.attempts || 0,
          trigger: event.payload?.trigger || null,
          delivery: event.delivery || { outcome: 'acknowledged' },
          error: event.error || null,
        })),
      heartbeatInstallations: installationHeartbeatStatus,
    });
  } catch (error) {
    console.error('Error fetching admin agent events:', error);
    return res.status(500).json({ error: 'Failed to fetch agent event dashboard data' });
  }
});

module.exports = router;
