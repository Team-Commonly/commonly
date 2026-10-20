// The schema itself: `actioned` is a value the store accepts, and an unknown
// value is still refused.
const mongoose = require('mongoose');
const AttentionItem = require('../../../models/AttentionItem');

const row = (resolvedBy) => new AttentionItem({
  recipientUserId: new mongoose.Types.ObjectId(),
  podId: new mongoose.Types.ObjectId(),
  kind: 'mention',
  source: { type: 'message', id: '42' },
  title: 'Your agent is installed but not running',
  status: 'resolved',
  resolvedBy,
});

describe('AttentionItem.resolvedBy accepts actioned', () => {
  it.each(['replied', 'acknowledged', 'actioned'])('accepts %s', (value) => {
    expect(row(value).validateSync()).toBeUndefined();
  });

  it('refuses an unknown value', () => {
    expect(row('done').validateSync()?.errors?.resolvedBy).toBeDefined();
  });
});
