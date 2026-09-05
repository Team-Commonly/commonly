const mongoose = require('mongoose');
const Integration = require('../../../models/Integration');

describe('Integration JSON serialization', () => {
  it('exposes a pause reason and time without the moderator identity', () => {
    const pausedAt = new Date('2026-09-05T08:48:00.000Z');
    const integration = new Integration({
      type: 'telegram',
      createdBy: new mongoose.Types.ObjectId(),
      config: {
        adminPause: {
          reason: 'Safety review in progress.',
          at: pausedAt,
          adminId: 'admin-private-id',
        },
      },
    });

    const body = integration.toJSON();

    expect(body.config.adminPause).toEqual({
      reason: 'Safety review in progress.',
      at: pausedAt,
    });
    expect(JSON.stringify(body)).not.toMatch(/adminId|admin-private-id/);
  });
});
