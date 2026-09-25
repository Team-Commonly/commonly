jest.mock('../../../models/Integration', () => ({
  findOne: jest.fn(),
  findByIdAndUpdate: jest.fn(),
}));
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../services/telegramService', () => ({ sendMessage: jest.fn() }));
jest.mock('../../../services/connectorSecrets', () => ({ get: jest.fn() }));
jest.mock('../../../services/slackApi', () => jest.fn());
jest.mock('../../../services/connectorRelayPolicy', () => ({ shouldEscalate: jest.fn(() => false) }));
jest.mock('../../../services/channelVerdictService', () => ({ record: jest.fn() }));

const Integration = require('../../../models/Integration');
const Pod = require('../../../models/Pod');
const telegramSend = require('../../../services/telegramService');
const connectorSecrets = require('../../../services/connectorSecrets');
const SlackApi = require('../../../services/slackApi');
const { shouldEscalate } = require('../../../services/connectorRelayPolicy');
const verdicts = require('../../../services/channelVerdictService');
const {
  relayAgentMessageToTelegram,
  renderTelegramDecisionCard,
} = require('../../../services/telegramBridgeService');
const {
  relayAgentMessageToSlack,
  renderSlackDecisionCard,
} = require('../../../services/slackBridgeService');

const CARD = {
  title: 'Choose <a href="https://untrusted.test">the rollout</a> & safely',
  question: 'Should we take the low-risk path?',
  options: [
    { label: 'Later', description: 'L'.repeat(280) },
    { label: 'Canary <fast>', description: 'C'.repeat(280), recommended: true },
    { label: 'Full rollout', description: 'F'.repeat(280) },
    { label: 'Pause', description: 'P'.repeat(280) },
  ],
  context: 'This private context must never cross the bridge.',
};

const telegramIntegration = (config = {}) => ({
  _id: 'telegram-1',
  installationId: 'install-telegram',
  podId: 'pod-1',
  scope: 'user',
  type: 'telegram',
  isActive: true,
  config: {
    liveRelay: true,
    chatType: 'private',
    chatId: 'telegram-chat',
    gates: { 'pod-1': { enabled: true } },
    ...config,
  },
});

const slackIntegration = (config = {}) => ({
  _id: 'slack-1',
  installationId: 'install-slack',
  podId: 'pod-1',
  scope: 'user',
  type: 'slack',
  isActive: true,
  config: {
    liveRelay: true,
    chatType: 'im',
    chatId: 'slack-chat',
    teamId: 'T1',
    botTokenRef: 'slack-secret',
    gates: { 'pod-1': { enabled: true } },
    ...config,
  },
});

const cardSend = (integration, card = CARD) => ({
  podId: 'pod-1',
  agentUsername: 'release-agent',
  displayName: 'Release Agent',
  content: 'The workspace copy remains ordinary text.',
  podMessageId: '731',
  card,
  integration,
});

describe('decision-card outbound bridges', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TELEGRAM_BOT_TOKEN = 'telegram-token';
    process.env.PUBLIC_APP_URL = 'https://commonly.test';
    telegramSend.sendMessage.mockResolvedValue({ messageId: 42 });
    connectorSecrets.get.mockResolvedValue('xoxb-token');
    SlackApi.mockImplementation(() => ({ postMessage: jest.fn().mockResolvedValue({ ok: true, ts: '1700.0001' }) }));
    Pod.findById.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ name: 'Launch week' }) }) });
    Integration.findByIdAndUpdate.mockResolvedValue(undefined);
    verdicts.record.mockResolvedValue(undefined);
  });

  afterAll(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.PUBLIC_APP_URL;
  });

  test('Telegram sends a card as an interrupt without consulting prose escalation and records it once', async () => {
    await relayAgentMessageToTelegram(cardSend(telegramIntegration()));

    expect(shouldEscalate).not.toHaveBeenCalled();
    expect(telegramSend.sendMessage).toHaveBeenCalledTimes(1);
    const text = telegramSend.sendMessage.mock.calls[0][2];
    expect(text.length).toBeLessThanOrEqual(1900);
    expect(text).toContain('Release Agent needs a ruling');
    expect(text).toContain('&lt;a href="https://untrusted.test"&gt;the rollout&lt;/a&gt; &amp; safely');
    expect(text).not.toContain('This private context must never cross the bridge.');
    expect(text.indexOf('1. <b>Later</b>')).toBeLessThan(text.indexOf('2. <b>Canary &lt;fast&gt;</b>'));
    expect(text.indexOf('2. <b>Canary &lt;fast&gt;</b>')).toBeLessThan(text.indexOf('3. <b>Full rollout</b>'));
    expect((text.match(/★ recommended/g) || [])).toHaveLength(1);
    expect(text).toContain(`${'L'.repeat(99)}…`);
    expect(text).toContain('?message=731');
    expect(verdicts.record).toHaveBeenCalledWith(expect.objectContaining({
      integrationId: 'telegram-1',
      provider: 'telegram',
      event: { kind: 'decision_request', podMessageId: '731' },
      verdict: 'interrupt',
      reason: 'card',
    }));
  });

  test('Slack sends the same ordered card with mrkdwn-safe fields', async () => {
    await relayAgentMessageToSlack(cardSend(slackIntegration()));

    expect(shouldEscalate).not.toHaveBeenCalled();
    const api = SlackApi.mock.results[0].value;
    const text = api.postMessage.mock.calls[0][1];
    expect(text.length).toBeLessThanOrEqual(1900);
    expect(text).toContain('*Release Agent needs a ruling · Choose &lt;a href="https://untrusted.test"&gt;the rollout&lt;/a&gt; &amp; safely*');
    expect(text).toContain('2. *Canary &lt;fast&gt;* ★ recommended');
    expect(text).not.toContain('This private context must never cross the bridge.');
    expect(text).toContain(`${'L'.repeat(99)}…`);
    expect(verdicts.record).toHaveBeenCalledWith(expect.objectContaining({
      integrationId: 'slack-1', provider: 'slack', verdict: 'interrupt', reason: 'card',
    }));
  });

  test('Slack escapes every agent-authored card field before rendering mrkdwn', () => {
    const hostile = '<https://evil.example|open in Commonly> &';
    const text = renderSlackDecisionCard({
      card: {
        title: `${hostile} title`,
        question: `${hostile} question`,
        options: [{ label: `${hostile} label`, description: `${hostile} description` }],
      },
      displayName: `${hostile} agent`,
      agentUsername: 'release-agent',
      link: 'https://commonly.test/v2/pods/pod-1?message=731',
    });

    expect(text).not.toContain('<https://evil.example|open in Commonly>');
    expect(text.match(/&lt;https:\/\/evil\.example\|open in Commonly&gt; &amp;/g)).toHaveLength(5);
    expect(text).toContain('https://commonly.test/v2/pods/pod-1?message=731');
  });

  test.each([
    ['Telegram', 'muted', relayAgentMessageToTelegram, telegramIntegration, { relayMutedUntil: new Date(Date.now() + 60_000) }],
    ['Telegram', 'paused', relayAgentMessageToTelegram, telegramIntegration, { adminPause: { reason: 'Safety review' } }],
    ['Telegram', 'gate_off', relayAgentMessageToTelegram, telegramIntegration, { gates: { 'pod-1': { enabled: false } } }],
    ['Slack', 'muted', relayAgentMessageToSlack, slackIntegration, { relayMutedUntil: new Date(Date.now() + 60_000) }],
    ['Slack', 'paused', relayAgentMessageToSlack, slackIntegration, { adminPause: { reason: 'Safety review' } }],
    ['Slack', 'gate_off', relayAgentMessageToSlack, slackIntegration, { gates: { 'pod-1': { enabled: false } } }],
  ])('%s holds a card when %s', async (_provider, reason, relay, integrationFor, config) => {
    await relay(cardSend(integrationFor(config)));

    expect(telegramSend.sendMessage).not.toHaveBeenCalled();
    expect(SlackApi).not.toHaveBeenCalled();
    expect(verdicts.record).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'hold', reason }));
  });

  test('keeps ordinary Telegram and Slack relay content at 900 characters', async () => {
    const ordinary = `[DECISION] ${'x'.repeat(1_000)}`;
    shouldEscalate.mockReturnValue(true);
    await relayAgentMessageToTelegram({ ...cardSend(telegramIntegration()), card: undefined, content: ordinary });
    await relayAgentMessageToSlack({ ...cardSend(slackIntegration()), card: undefined, content: ordinary });

    const telegramText = telegramSend.sendMessage.mock.calls[0][2];
    expect(telegramText).toContain('x'.repeat(889));
    expect(telegramText).not.toContain('x'.repeat(890));
    const slackText = SlackApi.mock.results[0].value.postMessage.mock.calls[0][1];
    expect(slackText).toBe(`[Launch week] Release Agent: ${ordinary.slice(0, 900)}`);
  });

  test('keeps a maximum valid card below 1900 without trimming its title, question, or labels', () => {
    const maximum = {
      title: 'T'.repeat(160),
      question: 'Q'.repeat(1000),
      options: Array.from({ length: 4 }, (_, index) => ({
        label: String(index + 1).repeat(80), description: 'D'.repeat(280),
      })),
    };
    const telegram = renderTelegramDecisionCard({ card: maximum, displayName: 'Agent', agentUsername: 'agent', link: 'https://commonly.test/link' });
    const slack = renderSlackDecisionCard({ card: maximum, displayName: 'Agent', agentUsername: 'agent', link: 'https://commonly.test/link' });

    for (const text of [telegram, slack]) {
      expect(text.length).toBeLessThanOrEqual(1900);
      expect(text).toContain(maximum.title);
      expect(text).toContain(maximum.question);
      maximum.options.forEach((option, index) => {
        expect(text).toContain(`${index + 1}.`);
        expect(text).toContain(option.label);
      });
    }
  });
});
