/**
 * TASK-075 — behavioural delivery pins for the three observability warns on
 * the `postMessage` path.
 *
 * These REPLACE a source-text assertion in
 * `agentMessageService.chatNoise.test.js` that read the service file and
 * matched the `let sanitizedContent = ...sanitizeAgentContent(content, {...})`
 * statement. That pin was hardened twice in one hour — first defeated by a
 * `//` comment decoy, then by `/* *\/` — and each round bought exactly one
 * counterexample while leaving the class open: it still passed with the
 * feature off if the text lived in a string literal, or in a second,
 * unreachable `let sanitizedContent = …` in another method of a 1,900-line
 * class. Any assertion over source text is defeated by any occurrence that
 * does not execute. Comments were the likeliest instance, not the last one.
 *
 * So these exercise `postMessage` itself and assert the warn actually FIRES.
 * That is the only form that distinguishes *wired* from *textually resembles
 * being wired*, and it is also blind to nothing a rename can do.
 *
 * The predicate-level tests stay where they are — `sanitizeAgentContent`'s own
 * suite pins WHEN each warn should fire. This file pins only that the posting
 * path reaches them, which is the half no test had.
 *
 * Harness is the ~60-line `postMessage` mock set from
 * `agentMessageService.phantom-directive.test.js`.
 */

const AgentMessageService = require('../../../services/agentMessageService');
const Message = require('../../../models/Message');
const AgentIdentityService = require('../../../services/agentIdentityService');
const socketConfig = require('../../../config/socket');
const DMService = require('../../../services/dmService');
const File = require('../../../models/File');

jest.mock('../../../models/Message');
jest.mock('../../../models/Summary', () => ({
  findOne: jest.fn().mockResolvedValue(null),
  create: jest.fn(),
}));
jest.mock('../../../services/agentIdentityService', () => ({
  getOrCreateAgentUser: jest.fn(),
  ensureAgentInPod: jest.fn(),
  buildAgentUsername: jest.fn((agentName, instanceId) => `${agentName}-${instanceId}`),
}));
jest.mock('../../../services/podAssetService', () => ({
  createChatSummaryAsset: jest.fn(),
}));
jest.mock('../../../config/socket', () => ({ getIO: jest.fn() }));
jest.mock('../../../services/dmService', () => ({
  resolveAgentOwner: jest.fn(),
  getOrCreateAdminDMPod: jest.fn(),
}));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: {
    find: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    })),
  },
}));
jest.mock('../../../models/User', () => ({
  find: jest.fn(() => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue([]),
  })),
  findOne: jest.fn(() => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(null),
  })),
}));
jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(() => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue({ type: 'chat' }),
  })),
}));
jest.mock('../../../models/File', () => ({
  find: jest.fn(),
  findOne: jest.fn(() => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(null),
  })),
}));

const POD_ID = '6a0da39bae757028b39f87a6';
let persistedDoc;
let warn;

beforeEach(() => {
  jest.clearAllMocks();
  persistedDoc = null;
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(AgentMessageService, 'getRecentMessages').mockResolvedValue([]);
  File.find.mockReturnValue({
    select: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue([]),
  });
  AgentIdentityService.getOrCreateAgentUser.mockResolvedValue({
    _id: 'agent-user-1',
    username: 'openclaw-nova',
    profilePicture: 'default',
  });
  AgentIdentityService.ensureAgentInPod.mockResolvedValue({ _id: 'pod-1' });
  socketConfig.getIO.mockReturnValue({ to: () => ({ emit: jest.fn() }) });
  Message.mockImplementation(function MockMessage(doc) {
    persistedDoc = doc;
    return {
      ...doc,
      _id: 'msg-1',
      createdAt: new Date(),
      save: jest.fn().mockResolvedValue(true),
      populate: jest.fn().mockResolvedValue({ ...doc, _id: 'msg-1' }),
    };
  });
  DMService.resolveAgentOwner.mockResolvedValue(null);
  DMService.getOrCreateAdminDMPod.mockResolvedValue({ _id: 'dm-pod-1' });
});

afterEach(() => {
  warn.mockRestore();
  if (AgentMessageService.getRecentMessages.mockRestore) {
    AgentMessageService.getRecentMessages.mockRestore();
  }
});

const warnsContaining = (needle) => warn.mock.calls
  .map(([first]) => String(first))
  .filter((line) => line.includes(needle));

const post = (content) => AgentMessageService.postMessage({
  agentName: 'openclaw',
  instanceId: 'nova',
  podId: POD_ID,
  content,
});

describe('postMessage delivers the sentinel-strip warn', () => {
  it('fires, with identity, when a bare sentinel is edited out of a substantive reply', async () => {
    await post('A reply of NO_REPLY means silence.');

    const [line, ...rest] = warnsContaining('stripped bare sentinel');
    expect(line).toBeDefined();
    // Exactly one: the sanitizer runs once per post. A second line would mean
    // the posting path sanitizes twice, which would double every count built
    // on this warn.
    expect(rest).toHaveLength(0);
    // Identity is the whole opt-in — `observe` is what postMessage passes, and
    // dropping it is the mutation the old source pin was written for. An
    // anonymous line cannot be attributed to a seat and the metric dies.
    expect(line).toContain('agent=openclaw');
    expect(line).toContain('instance=nova');
    expect(line).toContain(`pod=${POD_ID}`);
    // And the message still posts, edited. The warn exists precisely because
    // this is an edit rather than a suppression — if it were silently dropped
    // there would be nothing to observe.
    expect(persistedDoc.content).toBe('A reply of  means silence.');
  });

  it('stays silent through postMessage when the sentinel IS the whole reply', async () => {
    // The control that stops this becoming "warns on every post". Total-match
    // is suppression, not an edit: it must not inflate the count, or the rate
    // measures ordinary heartbeat traffic.
    await post('NO_REPLY');
    expect(warnsContaining('stripped bare sentinel')).toHaveLength(0);
    expect(persistedDoc).toBeNull();
  });

  it('stays silent through postMessage on a backticked sentinel and ordinary prose', async () => {
    await post('Backtick it: `NO_REPLY` survives.');
    await post('An ordinary reply with no sentinel at all.');
    expect(warnsContaining('stripped bare sentinel')).toHaveLength(0);
  });
});

// The two sibling suppressions had no delivery pin of ANY kind — not even a
// source-text one. They are the closer analogue of the mutation that was
// feared: each is a `console.warn` immediately before `sanitizedContent = ''`,
// so deleting the warn and keeping the zeroing loses the whole record of a
// swallowed post while every predicate test stays green.
describe('postMessage delivers the two runtime-failure suppression warns', () => {
  it('warns with identity and posts nothing for a runtime model failure', async () => {
    await post('⚠️ Agent failed before reply: All models failed (4): openrouter/x: 401');

    const [line] = warnsContaining('suppressed runtime model-failure');
    expect(line).toBeDefined();
    expect(line).toContain('agent=openclaw');
    expect(line).toContain('instance=nova');
    expect(line).toContain(`pod=${POD_ID}`);
    expect(persistedDoc).toBeNull();
  });

  it('warns with identity and posts nothing for a gateway tool-failure note', async () => {
    await post('⚠️ 📝 Edit: in /workspace/nova/MEMORY.md (196 chars) failed');

    const [line] = warnsContaining('suppressed runtime tool-failure note');
    expect(line).toBeDefined();
    expect(line).toContain('agent=openclaw');
    expect(line).toContain('instance=nova');
    expect(line).toContain(`pod=${POD_ID}`);
    expect(persistedDoc).toBeNull();
  });

  it('does not fire either suppression warn on an ordinary reply', async () => {
    await post('The MEMORY.md edit failed twice, so I rewrote the file instead — done.');
    expect(warnsContaining('suppressed runtime model-failure')).toHaveLength(0);
    expect(warnsContaining('suppressed runtime tool-failure note')).toHaveLength(0);
    expect(persistedDoc).toBeTruthy();
  });
});
