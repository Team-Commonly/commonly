// The schema itself, not a mock: `missed` must be a value the store accepts,
// alongside the two it already had, and nothing else may slip in.
const mongoose = require('mongoose');
const AttentionItem = require('../../../models/AttentionItem');

const row = (resolvedBy) => new AttentionItem({
  recipientUserId: new mongoose.Types.ObjectId(),
  podId: new mongoose.Types.ObjectId(),
  kind: 'mention',
  source: { type: 'message', id: '42' },
  title: 'Kai mentioned you',
  status: 'resolved',
  resolvedBy,
});

describe('AttentionItem.resolvedBy', () => {
  it.each(['replied', 'acknowledged', 'missed'])('accepts %s', (value) => {
    expect(row(value).validateSync()).toBeUndefined();
  });

  it('refuses anything else', () => {
    expect(row('expired').validateSync()?.errors?.resolvedBy).toBeDefined();
  });
});
