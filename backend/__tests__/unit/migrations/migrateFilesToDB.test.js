jest.mock('mongoose', () => ({ connect: jest.fn(), disconnect: jest.fn() }));
jest.mock('../../../models/File', () => ({ findByFileName: jest.fn() }));
const fs = require('fs');
process.env.MONGO_URI = 'mongodb://test';
const migrateFiles = require('../../../migrations/migrateFilesToDB');

describe('migrateFiles', () => {
  beforeEach(() => {
    jest.spyOn(process, 'exit').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('exits when uploads directory is missing', async () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    jest.spyOn(fs, 'readdirSync').mockReturnValue([]);
    await migrateFiles();
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('exits when no files found', async () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readdirSync').mockReturnValue([]);
    await migrateFiles();
    expect(process.exit).toHaveBeenCalledWith(0);
  });
});
