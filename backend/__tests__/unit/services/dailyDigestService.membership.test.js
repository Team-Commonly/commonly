const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');
const User = require('../../../models/User');
const Pod = require('../../../models/Pod');
const Summary = require('../../../models/Summary');
const { DailyDigestService } = require('../../../services/dailyDigestService');

let serial = 0;
const person = async (lastActive = new Date()) => {
  serial += 1;
  return User.create({
    username: `digest-member-${serial}`,
    email: `digest-member-${serial}@example.com`,
    password: 'Password123!',
    lastActive,
  });
};

const podWithSummary = async (owner, name, options = {}) => {
  const pod = await Pod.create({
    name,
    createdBy: owner._id,
    members: [owner._id, ...(options.members || []).map((member) => member._id)],
    publicRead: options.publicRead || false,
  });
  await Summary.create({
    type: 'chats',
    podId: pod._id,
    title: `${name} update`,
    content: `- Work in ${name}`,
    timeRange: { start: new Date(Date.now() - 60000), end: new Date() },
    metadata: { totalItems: 1 },
  });
  return pod;
};

beforeAll(setupMongoDb);
afterAll(closeMongoDb);
afterEach(clearMongoDb);

test('digest reads current pod membership without subscribedPods and excludes another pod', async () => {
  const member = await person();
  const creator = await person();
  const other = await person();
  await podWithSummary(creator, 'Member Pod', { members: [member] });
  await podWithSummary(other, 'Other Pod');
  const service = new DailyDigestService();
  jest.spyOn(service, 'generateDigestContent').mockImplementation(async (data) =>
    Object.keys(data.byPod).join(', '));

  const digest = await service.generateUserDailyDigest(member._id);

  expect(member.subscribedPods).toHaveLength(0);
  expect(digest.metadata.totalItems).toBe(1);
  expect(digest.content).toContain('Member Pod');
  expect(digest.content).not.toContain('Other Pod');
});

// Cofounder's condition on #2210, before any outside digest: the query used to
// add every `posts` summary and every pod-less chat summary to EVERY digest,
// whatever pods the recipient is in. Zero such rows existed on 10-16, so
// nothing leaked, but one posts summary would have mailed one pod's activity
// to non-members. A digest reads the recipient's own pods and nothing else.
test("a digest never carries another pod's posts summary or a pod-less summary", async () => {
  const member = await person();
  const outsider = await person();
  await podWithSummary(member, 'Member Pod');
  const elsewhere = await Pod.create({ name: 'Private Elsewhere', createdBy: outsider._id, members: [outsider._id] });
  await Summary.create({
    type: 'posts',
    podId: elsewhere._id,
    title: 'Private Elsewhere posts',
    content: '- A private post',
    timeRange: { start: new Date(Date.now() - 60000), end: new Date() },
    metadata: { totalItems: 1 },
  });
  await Summary.create({
    type: 'chats',
    title: 'Pod-less chat summary',
    content: '- Somewhere else',
    timeRange: { start: new Date(Date.now() - 60000), end: new Date() },
    metadata: { totalItems: 1 },
  });
  const service = new DailyDigestService();
  jest.spyOn(service, 'generateDigestContent').mockImplementation(async (data) =>
    Object.keys(data.byPod).join(', '));

  const digest = await service.generateUserDailyDigest(member._id);

  expect(digest.metadata.totalItems).toBe(1);
  expect(digest.content).toBe('Member Pod');
});

test('scheduler includes a member with recent pod work even after seven days away', async () => {
  const member = await person(new Date(Date.now() - 10 * 86400000));
  const creator = await person(new Date(Date.now() - 10 * 86400000));
  await podWithSummary(creator, 'Active Agent Pod', { members: [member] });
  const service = new DailyDigestService();
  const generate = jest.spyOn(service, 'generateUserDailyDigest').mockResolvedValue({ _id: 'digest-1' });

  const results = await service.generateAllDailyDigests();

  expect(generate).toHaveBeenCalledWith(member._id);
  expect(results).toHaveLength(2);
});

test('scheduler does not wake a stale member for public-read pod activity', async () => {
  const member = await person(new Date(Date.now() - 10 * 86400000));
  await podWithSummary(member, 'Public Pod', { publicRead: true });
  const service = new DailyDigestService();
  const generate = jest.spyOn(service, 'generateUserDailyDigest').mockResolvedValue({ _id: 'digest-1' });

  await service.generateAllDailyDigests();

  expect(generate).not.toHaveBeenCalled();
});

test('scheduler does not generate a digest for a bot', async () => {
  const bot = await person();
  bot.isBot = true;
  await bot.save();
  await podWithSummary(bot, 'Bot Pod');
  const service = new DailyDigestService();
  const generate = jest.spyOn(service, 'generateUserDailyDigest').mockResolvedValue({ _id: 'digest-1' });

  await service.generateAllDailyDigests();

  expect(generate).not.toHaveBeenCalled();
});
