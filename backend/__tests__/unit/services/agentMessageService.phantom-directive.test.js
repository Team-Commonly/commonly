/**
 * Regression test for the phantom-upload-directive defence
 * (smoke 2026-05-20 cycle 11, P0).
 *
 * The original false-attach footer (PR #68) caught past-tense narration
 * with NO `[[upload:` directive. It does NOT catch an agent who TYPES a
 * `[[upload:X]]` directive as plain text without actually calling
 * `commonly_attach_file`. Aria did this — her message contained the
 * directive substring but the pod had zero File rows, so the directive
 * was completely fake but the safety chain treated it as valid.
 *
 * This second-layer check validates each `[[upload:X|...]]` directive's
 * first segment against the File collection scoped to the podId.
 * Anything not matching gets a different system note so the two failure
 * modes (narration-with-no-directive vs typed-fake-directive) can be
 * told apart in logs and UI.
 */

const AgentMessageService = require('../../../services/agentMessageService');
const Message = require('../../../models/Message');
const Summary = require('../../../models/Summary');
const AgentIdentityService = require('../../../services/agentIdentityService');
const PodAssetService = require('../../../services/podAssetService');
const socketConfig = require('../../../config/socket');
const DMService = require('../../../services/dmService');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const User = require('../../../models/User');
const Pod = require('../../../models/Pod');
const File = require('../../../models/File');

jest.mock('../../../models/Message');
jest.mock('../../../models/Summary', () => ({
  findOne: jest.fn().mockResolvedValue(null),
  create: jest.fn(),
}));
jest.mock('../../../services/agentIdentityService', () => ({
  getOrCreateAgentUser: jest.fn(),
  ensureAgentInPod: jest.fn(),
}));
jest.mock('../../../services/podAssetService', () => ({
  createChatSummaryAsset: jest.fn(),
}));
jest.mock('../../../config/socket', () => ({
  getIO: jest.fn(),
}));
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
}));
jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(() => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue({ type: 'chat' }),
  })),
}));
jest.mock('../../../models/File', () => ({
  findOne: jest.fn(),
}));

// Build a File.findOne mock that resolves to the matching row when the
// directive name is in `present`, otherwise null. Pass an object keyed by
// directive name to fileName (so the test reads naturally).
const mockFindOneAgainst = (present) => {
  File.findOne.mockImplementation((query) => {
    const orClauses = query?.$or || [];
    const candidate = orClauses[0]?.fileName || orClauses[1]?.originalName;
    return {
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(present[candidate] || null),
    };
  });
};

// Capture the persisted Message doc so we can assert what content actually
// landed (with or without the footer appended).
let persistedDoc;
beforeEach(() => {
  jest.clearAllMocks();
  persistedDoc = null;
  jest.spyOn(AgentMessageService, 'getRecentMessages').mockResolvedValue([]);
  AgentIdentityService.getOrCreateAgentUser.mockResolvedValue({
    _id: 'agent-user-1',
    username: 'openclaw-aria',
    profilePicture: 'default',
  });
  AgentIdentityService.ensureAgentInPod.mockResolvedValue({ _id: 'pod-1' });
  socketConfig.getIO.mockReturnValue({
    to: () => ({ emit: jest.fn() }),
  });
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
  if (AgentMessageService.getRecentMessages.mockRestore) {
    AgentMessageService.getRecentMessages.mockRestore();
  }
});

describe('AgentMessageService phantom-upload-directive footer', () => {
  it('appends a phantom-directive footer when [[upload:X]] references no File row', async () => {
    // No File row matches any directive → phantom.
    mockFindOneAgainst({});

    await AgentMessageService.postMessage({
      agentName: 'openclaw',
      instanceId: 'aria',
      podId: '6a0da39bae757028b39f87a6',
      content: '[[upload:smoke-postmortem-2026-05-20-v2.md]]',
    });

    expect(persistedDoc).toBeTruthy();
    expect(persistedDoc.content).toContain('no matching attachment was found');
    expect(persistedDoc.content).toContain('smoke-postmortem-2026-05-20-v2.md');
    // The original directive must STILL be preserved so the existing
    // false-attach footer (which gates on `[[upload:` presence) doesn't
    // double-fire.
    expect(persistedDoc.content).toContain('[[upload:smoke-postmortem-2026-05-20-v2.md]]');
  });

  it('does NOT append a footer when a File row matches the directive', async () => {
    // Real upload exists → no phantom.
    mockFindOneAgainst({
      'storage-key-abc': { _id: 'file-1' },
    });

    await AgentMessageService.postMessage({
      agentName: 'openclaw',
      instanceId: 'aria',
      podId: '6a0da39bae757028b39f87a6',
      content: 'Here is the file: [[upload:storage-key-abc|real-doc.md|1234|file]]',
    });

    expect(persistedDoc).toBeTruthy();
    expect(persistedDoc.content).not.toContain('no matching attachment was found');
    expect(persistedDoc.content).toContain('[[upload:storage-key-abc');
  });

  it('matches when the directive references originalName instead of fileName', async () => {
    // The findOne query checks BOTH fileName and originalName via $or. As
    // long as the impl includes originalName as an alternative, the lookup
    // resolves. Mock returns a hit when queried with 'pitch.pptx' as
    // either field. Tested by having the mock return a row for any name
    // we configure.
    mockFindOneAgainst({
      'pitch.pptx': { _id: 'file-2' },
    });

    await AgentMessageService.postMessage({
      agentName: 'openclaw',
      instanceId: 'pixel',
      podId: '6a0da39bae757028b39f87a6',
      content: '[[upload:pitch.pptx]]',
    });

    expect(persistedDoc).toBeTruthy();
    expect(persistedDoc.content).not.toContain('no matching attachment was found');
  });

  it('flags only the phantom directive when multiple are present and some are real', async () => {
    // 'real-storage-key' resolves, 'made-up.md' does not.
    mockFindOneAgainst({
      'real-storage-key': { _id: 'file-3' },
    });

    await AgentMessageService.postMessage({
      agentName: 'openclaw',
      instanceId: 'nova',
      podId: '6a0da39bae757028b39f87a6',
      content: 'Two files: [[upload:real-storage-key|real.md]] and [[upload:made-up.md]]',
    });

    expect(persistedDoc.content).toContain('no matching attachment was found');
    expect(persistedDoc.content).toContain('made-up.md');
    // The real one should not be flagged in the phantom list.
    const phantomLine = persistedDoc.content.split('\n').find((l) => l.includes('no matching attachment'));
    expect(phantomLine).toBeTruthy();
    expect(phantomLine).not.toContain('real-storage-key');
  });

  it('does not append a footer when there is no upload directive at all', async () => {
    // No directive → impl should skip the lookup entirely.
    await AgentMessageService.postMessage({
      agentName: 'openclaw',
      instanceId: 'theo',
      podId: '6a0da39bae757028b39f87a6',
      content: 'Just a regular chat message with no upload reference.',
    });

    expect(persistedDoc.content).not.toContain('no matching attachment was found');
    // File lookup should not even fire when no directive is present.
    expect(File.findOne).not.toHaveBeenCalled();
  });

  it('does not block the message when the File lookup throws', async () => {
    File.findOne.mockImplementationOnce(() => {
      throw new Error('mongo connection lost');
    });

    const result = await AgentMessageService.postMessage({
      agentName: 'openclaw',
      instanceId: 'aria',
      podId: '6a0da39bae757028b39f87a6',
      content: '[[upload:something.md]]',
    });

    expect(persistedDoc).toBeTruthy();
    expect(persistedDoc.content).toContain('[[upload:something.md]]');
    // Lookup failure must NOT corrupt the message with a footer.
    expect(persistedDoc.content).not.toContain('no matching attachment was found');
    expect(result).toBeTruthy();
  });
});
