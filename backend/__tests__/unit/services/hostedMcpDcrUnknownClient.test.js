/**
 * Which vendor refusals mean "I don't know this client". RFC 6749's
 * invalid_client, and api.supabase.com's own 422 {"message":"Unrecognized
 * client_id"} (probed 2026-11-04). Anything else is not one.
 */
const { refusalNamesUnknownClient } = require('../../../services/hostedMcpDcrRegistry');

describe('refusalNamesUnknownClient', () => {
  test.each([
    [{ error: 'invalid_client' }],
    [{ error: 'invalid_client', error_description: 'Client authentication failed' }],
    [{ message: 'Unrecognized client_id' }],
    [{ message: ' unrecognized client_id ' }],
  ])('%j names an unknown client', (refusal) => {
    expect(refusalNamesUnknownClient(refusal)).toBe(true);
  });

  test.each([
    [{ error: 'invalid_grant' }],
    [{ error: 'invalid_request' }],
    [{ message: 'Required parameter: client_secret' }],
    [{ message: 'Unrecognized client_id, and also something else' }],
    [{ error: { message: 'Unrecognized client_id' } }],
    [{}],
    [null],
    ['invalid_client'],
  ])('%j does not', (refusal) => {
    expect(refusalNamesUnknownClient(refusal)).toBe(false);
  });
});
