const { PENDING_APPROVAL_NOTE } = require('../../../services/brokerResultMarker');

// An agent relays this note in its own words. Without a subject it wrote
// "Linear parked it", so the vendor got the credit for Commonly's gate.
test('the parked note says who parked the call', () => {
  expect(PENDING_APPROVAL_NOTE).toMatch(/^Commonly parked this/);
  expect(PENDING_APPROVAL_NOTE).toContain('Nothing has been sent yet.');
});

// "The Linear connection owner" read as though Linear approves it, and "I'll
// confirm here" promised a post that the resolved wake is built not to make.
test('the parked note names the card, and leaves the outcome to it', () => {
  expect(PENDING_APPROVAL_NOTE).toContain('decides on a Commonly approval card');
  expect(PENDING_APPROVAL_NOTE).not.toContain('connection owner');
  expect(PENDING_APPROVAL_NOTE).toContain('the card shows the outcome on its own');
  expect(PENDING_APPROVAL_NOTE).toContain('do not say you will confirm later');
});
