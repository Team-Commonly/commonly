const mongoose = require('mongoose');

jest.mock('../../../models/AgentFirstContact', () => ({
  findOneAndUpdate: jest.fn(),
}));

jest.mock('../../../services/agentEventService', () => ({
  enqueue: jest.fn(),
}));

const AgentFirstContact = require('../../../models/AgentFirstContact');
const AgentEventService = require('../../../services/agentEventService');
const { maybeFireFirstContact } = require('../../../services/firstContactService');

const USER_ID = new mongoose.Types.ObjectId().toString();
const POD_ID = new mongoose.Types.ObjectId().toString();
const OTHER_POD_ID = new mongoose.Types.ObjectId().toString();

const firstInsert = () => ({
  value: null,
  lastErrorObject: { updatedExisting: false },
});

const existingMarker = () => ({
  value: { _id: 'marker-1' },
  lastErrorObject: { updatedExisting: true },
});

const baseOptions = (overrides = {}) => ({
  agentName: 'OpenClaw',
  instanceId: 'nova',
  podId: POD_ID,
  installedByUserId: USER_ID,
  installerIsAgent: false,
  ...overrides,
});

describe('firstContactService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AgentFirstContact.findOneAndUpdate.mockResolvedValue(firstInsert());
    AgentEventService.enqueue.mockResolvedValue({ _id: 'event-1' });
  });

  test('first install creates the durable marker and enqueues first_contact once', async () => {
    await maybeFireFirstContact(baseOptions());

    expect(AgentFirstContact.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update, options] = AgentFirstContact.findOneAndUpdate.mock.calls[0];
    expect(String(filter.userId)).toBe(USER_ID);
    expect(filter.agentName).toBe('openclaw');
    expect(String(update.$setOnInsert.firstPodId)).toBe(POD_ID);
    expect(update.$setOnInsert.createdAt).toBeInstanceOf(Date);
    expect(options).toEqual(expect.objectContaining({
      upsert: true,
      new: false,
      includeResultMetadata: true,
    }));

    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
    expect(AgentEventService.enqueue).toHaveBeenCalledWith({
      agentName: 'openclaw',
      instanceId: 'nova',
      podId: expect.any(mongoose.Types.ObjectId),
      type: 'first_contact',
      payload: {
        content: expect.stringMatching(/exactly ONE specific, answerable question.*One question mark, at the end\./s),
        userId: USER_ID,
        kind: 'first-contact',
      },
    });
  });

  test('reinstall with an existing marker does not enqueue or create a duplicate', async () => {
    AgentFirstContact.findOneAndUpdate.mockResolvedValue(existingMarker());

    await expect(maybeFireFirstContact(baseOptions())).resolves.toBeUndefined();

    expect(AgentFirstContact.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
  });

  test('concurrent installs enqueue exactly once when only one atomic upsert inserts', async () => {
    AgentFirstContact.findOneAndUpdate
      .mockResolvedValueOnce(firstInsert())
      .mockResolvedValueOnce(existingMarker());

    await Promise.all([
      maybeFireFirstContact(baseOptions()),
      maybeFireFirstContact(baseOptions()),
    ]);

    expect(AgentFirstContact.findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
  });

  test('agent-to-agent install returns before marker write or enqueue', async () => {
    await maybeFireFirstContact(baseOptions({ installerIsAgent: true }));

    expect(AgentFirstContact.findOneAndUpdate).not.toHaveBeenCalled();
    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
  });

  test('installing the same agent in a different pod does not re-fire', async () => {
    AgentFirstContact.findOneAndUpdate
      .mockResolvedValueOnce(firstInsert())
      .mockResolvedValueOnce(existingMarker());

    await maybeFireFirstContact(baseOptions());
    await maybeFireFirstContact(baseOptions({ podId: OTHER_POD_ID }));

    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
    const secondFilter = AgentFirstContact.findOneAndUpdate.mock.calls[1][0];
    expect(String(secondFilter.userId)).toBe(USER_ID);
    expect(secondFilter.agentName).toBe('openclaw');
    expect(secondFilter).not.toHaveProperty('firstPodId');
  });

  test('enqueue failure is logged and swallowed after the marker wins', async () => {
    AgentEventService.enqueue.mockRejectedValue(new Error('queue unavailable'));

    await expect(maybeFireFirstContact(baseOptions())).resolves.toBeUndefined();

    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      '[first-contact] event enqueue failed',
      expect.objectContaining({
        agent: 'openclaw',
        instance: 'nova',
        error: 'queue unavailable',
      }),
    );
  });
});
