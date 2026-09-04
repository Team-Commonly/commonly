const fs = require('fs');
const path = require('path');

describe('installable reconciler scheduling', () => {
  test('runs every five minutes without borrowing the heartbeat lease', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../../services/schedulerService.ts'),
      'utf8',
    );
    const start = source.indexOf('const installableReconcileJob');
    const job = source.slice(start - 500, source.indexOf('this.jobs = [', start));

    expect(job).toContain("'*/5 * * * *'");
    expect(job).toContain("require('./installable/installableReconciler')");
    expect(job).toContain('await reconciler.sweep()');
    expect(job).toContain('status+claimId CAS');
    expect(job).not.toContain('tryAcquireHeartbeatDispatchLease');
  });
});
