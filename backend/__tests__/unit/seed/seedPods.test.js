jest.mock('../../../models/Pod', () => ({
  deleteMany: jest.fn(),
  insertMany: jest.fn(),
}));
jest.mock('../../../models/User', () => jest.fn());
jest.mock('mongoose', () => ({ connect: jest.fn(), disconnect: jest.fn() }));
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const seedPods = require('../../../seed/seedPods');

describe('seedPods', () => {
  beforeEach(() => {
    jest.spyOn(process, 'exit').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    User.findOne = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates user when none exists', async () => {
    User.findOne.mockResolvedValue(null);
    const save = jest.fn();
    User.mockImplementation(() => ({ save }));
    await seedPods();
    expect(save).toHaveBeenCalled();
    expect(Pod.insertMany).toHaveBeenCalled();
  });

  it('uses existing user', async () => {
    User.findOne.mockResolvedValue({ _id: 'u1' });
    await seedPods();
    expect(Pod.deleteMany).toHaveBeenCalled();
    expect(Pod.insertMany).toHaveBeenCalled();
  });
});
