const request = require('supertest');
const express = require('express');
const fs = require('fs');

const docsRoutes = require('../../../routes/docs');

const app = express();
app.use('/api/docs', docsRoutes);

jest.mock('fs');

describe('docs routes', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it('serves the backend documentation', async () => {
    fs.readFile.mockImplementation((p, enc, cb) => cb(null, 'content'));
    const res = await request(app).get('/api/docs/backend');
    expect(res.status).toBe(200);
    expect(res.text).toBe('content');
    expect(fs.readFile).toHaveBeenCalled();
  });

  it('handles read errors gracefully', async () => {
    fs.readFile.mockImplementation((p, enc, cb) => cb(new Error('fail')));
    const res = await request(app).get('/api/docs/backend');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ message: 'Unable to load documentation' });
  });
});
