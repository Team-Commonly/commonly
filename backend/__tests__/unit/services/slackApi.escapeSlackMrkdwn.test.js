/* eslint-disable global-require, import/no-unresolved, import/extensions --
   the requires must follow jest.mock, and this corpus resolves TS through the TS parser */
// The Slack escape lives beside the one call that posts it (wren 73822), and its
// signature is the thing that had to be reconciled rather than copied: the bridge
// carried `(raw: string) => String(raw)` and the reconcile service
// `(value: unknown) => String(value || '')` (vera 73824). Either copy taken as
// the shared shape changes what a missing value renders as in a human's DM.
const SlackApi = require('../../../services/slackApi');

describe('SlackApi.escapeSlackMrkdwn', () => {
  test('neutralises the markup mrkdwn would otherwise draw', () => {
    expect(SlackApi.escapeSlackMrkdwn('<https://evil.example|click here>'))
      .toBe('&lt;https://evil.example|click here&gt;');
    expect(SlackApi.escapeSlackMrkdwn('<!channel> and <@U1>'))
      .toBe('&lt;!channel&gt; and &lt;@U1&gt;');
    expect(SlackApi.escapeSlackMrkdwn('a & b')).toBe('a &amp; b');
  });

  test('renders a missing value as nothing, never as the word undefined', () => {
    // The bridge's copy would have produced the string "undefined" here, which is
    // the regression that picking the wrong signature would have shipped.
    expect(SlackApi.escapeSlackMrkdwn(undefined)).toBe('');
    expect(SlackApi.escapeSlackMrkdwn(null)).toBe('');
  });

  test('keeps a legitimate 0 or false, which `||` would have swallowed', () => {
    expect(SlackApi.escapeSlackMrkdwn(0)).toBe('0');
    expect(SlackApi.escapeSlackMrkdwn(false)).toBe('false');
  });
});
