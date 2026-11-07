const { PENDING_APPROVAL_NOTE } = require('../../../services/brokerResultMarker');

// An agent relays this note in its own words. Without a subject it wrote
// "Linear parked it", so the vendor got the credit for Commonly's gate.
test('the parked note says who parked the call', () => {
  expect(PENDING_APPROVAL_NOTE).toMatch(/^Commonly parked this for the connection owner/);
  expect(PENDING_APPROVAL_NOTE).toContain('Nothing has been sent yet.');
});
