jest.mock('../../../models/User', () => {
  const User = jest.fn(function MockUser(doc) {
    Object.assign(this, doc);
    this.save = jest.fn().mockResolvedValue(this);
  });

  User.findOne = jest.fn();
  return User;
});

const User = require('../../../models/User');
const { ensureLocalDevLogin } = require('../../../services/localDevLoginService');

describe('localDevLoginService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      LOCAL_DEV_LOGIN_ENABLED: 'true',
      LOCAL_DEV_LOGIN_EMAIL: 'dev@commonly.local',
      LOCAL_DEV_LOGIN_PASSWORD: 'password123',
      LOCAL_DEV_LOGIN_USERNAME: 'localdev',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('creates the configured local dev user when missing', async () => {
    User.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const user = await ensureLocalDevLogin();

    expect(User.findOne).toHaveBeenNthCalledWith(1, { email: 'dev@commonly.local' });
    expect(User).toHaveBeenCalledWith({
      username: 'localdev',
      email: 'dev@commonly.local',
      password: 'password123',
      verified: true,
    });
    expect(user.save).toHaveBeenCalled();
  });

  it('updates the configured local dev user when it already exists', async () => {
    const existingUser = {
      _id: 'user-1',
      username: 'someone-else',
      email: 'dev@commonly.local',
      password: 'old-password',
      verified: false,
      save: jest.fn().mockResolvedValue(undefined),
    };

    User.findOne
      .mockResolvedValueOnce(existingUser)
      .mockResolvedValueOnce(null);

    const user = await ensureLocalDevLogin();

    expect(User).not.toHaveBeenCalled();
    expect(existingUser.username).toBe('localdev');
    expect(existingUser.password).toBe('password123');
    expect(existingUser.verified).toBe(true);
    expect(existingUser.save).toHaveBeenCalled();
    expect(user).toBe(existingUser);
  });
});
