// eslint-disable-next-line no-unused-vars
const mongoose = require('mongoose');
const User = require('../../../models/User');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../../utils/testUtils');

describe('User Model Tests', () => {
  // Setup and teardown for MongoDB
  beforeAll(async () => {
    await setupMongoDb();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  afterEach(async () => {
    await clearMongoDb();
  });

  it('should create a new user successfully with valid data', async () => {
    const userData = {
      username: 'testuser',
      email: 'test@example.com',
      password: 'Password123!',
    };

    const user = new User(userData);
    const savedUser = await user.save();

    expect(savedUser._id).toBeDefined();
    expect(savedUser.username).toBe(userData.username);
    expect(savedUser.email).toBe(userData.email);
    // Password should be hashed
    expect(savedUser.password).not.toBe(userData.password);
    // Default values should be set
    expect(savedUser.verified).toBe(false);
    expect(savedUser.profilePicture).toBe('default');
    expect(savedUser.createdAt).toBeDefined();
  });

  it('should not save a user without required fields', async () => {
    const userWithoutUsername = new User({
      email: 'test@example.com',
      password: 'Password123!',
    });

    const userWithoutEmail = new User({
      username: 'testuser',
      password: 'Password123!',
    });

    const userWithoutPassword = new User({
      username: 'testuser',
      email: 'test@example.com',
    });

    // Test missing username
    await expect(userWithoutUsername.save()).rejects.toThrow();

    // Test missing email
    await expect(userWithoutEmail.save()).rejects.toThrow();

    // Test missing password
    await expect(userWithoutPassword.save()).rejects.toThrow();
  });

  it('should not allow duplicate usernames', async () => {
    // Create first user
    const firstUser = new User({
      username: 'sameusername',
      email: 'first@example.com',
      password: 'Password123!',
    });
    await firstUser.save();

    // Try to create second user with same username
    const secondUser = new User({
      username: 'sameusername',
      email: 'second@example.com',
      password: 'Password123!',
    });

    await expect(secondUser.save()).rejects.toThrow();
  });

  it('should not allow duplicate emails', async () => {
    // Create first user
    const firstUser = new User({
      username: 'firstuser',
      email: 'same@example.com',
      password: 'Password123!',
    });
    await firstUser.save();

    // Try to create second user with same email
    const secondUser = new User({
      username: 'seconduser',
      email: 'same@example.com',
      password: 'Password123!',
    });

    await expect(secondUser.save()).rejects.toThrow();
  });

  it('should hash the password before saving', async () => {
    const password = 'Password123!';
    const user = new User({
      username: 'testuser',
      email: 'test@example.com',
      password,
    });

    const savedUser = await user.save();
    expect(savedUser.password).not.toBe(password);
    // Password should be a bcrypt hash which starts with $2a$ or $2b$
    expect(savedUser.password).toMatch(/^\$2[ab]\$/);
  });

  it('should correctly compare passwords with comparePassword method', async () => {
    const password = 'Password123!';
    const user = new User({
      username: 'testuser',
      email: 'test@example.com',
      password,
    });

    await user.save();

    // Correct password should return true
    const correctPasswordMatch = await user.comparePassword(password);
    expect(correctPasswordMatch).toBe(true);

    // Incorrect password should return false
    const incorrectPasswordMatch = await user.comparePassword('WrongPassword123!');
    expect(incorrectPasswordMatch).toBe(false);
  });
});
