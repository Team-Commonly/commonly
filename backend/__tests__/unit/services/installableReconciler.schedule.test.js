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

describe('registry drift sweep scheduling', () => {
  test('runs hourly as an applying pass, lease-free, and is started with the rest', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../../services/schedulerService.ts'),
      'utf8',
    );
    const start = source.indexOf('const registryDriftJob');
    const job = source.slice(start, source.indexOf('const decisionCardReconcileJob', start));

    expect(start).toBeGreaterThan(-1);
    expect(job).toContain("'39 * * * *'");
    expect(job).toContain("require('./installable/registryReconciler')");
    expect(job).toContain('sweepRegistryDrift({ dryRun: false })');
    expect(job).not.toContain('tryAcquireHeartbeatDispatchLease');
    expect(source.slice(source.indexOf('this.jobs = ['))).toContain('registryDriftJob,');
  });
});
