import assert from 'node:assert/strict';
import test from 'node:test';
import { runBetaRehearsal } from '../scripts/rehearse-beta.js';

test('beta editorial lifecycle survives admin outage and preserves rollback contracts', async () => {
  const report = await runBetaRehearsal();
  assert.equal(report.status, 'pass');
  assert.equal(report.draftInvisibility, 'pass');
  assert.equal(report.privatePreview.cacheControl, 'no-store');
  assert.equal(report.withdraw.responseContract, 'static 410');
  assert.equal(report.latestFallback.status, 'pass');
  assert.equal(report.editorialRestore.status, 'pass');
  assert.equal(report.operationalRollback.status, 'pass');
  assert.equal(report.adminOutage.adminHttpServiceStarted, false);
  assert.equal(report.adminOutage.publicListingStatus, 200);
  assert.equal(report.adminOutage.publicLatestStatus, 200);
});
