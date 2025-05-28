const mongoose = require('mongoose');
const connectDB = require('../../../config/db');

jest.mock('mongoose', () => ({
  connect: jest.fn(),
}));

describe('connectDB', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.MONGO_URI = 'mongodb://localhost/test';
  });

  it('connects using mongoose with provided URI', async () => {
    await connectDB();
    expect(mongoose.connect).toHaveBeenCalledWith(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
  });

  it('exits process when connection fails', async () => {
    mongoose.connect.mockRejectedValueOnce(new Error('fail'));
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    await connectDB();
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
