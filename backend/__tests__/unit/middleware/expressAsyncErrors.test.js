require('express-async-errors');

const express = require('express');
const request = require('supertest');
const { finalErrorHandler } = require('../../../middleware/finalErrorHandler');

it('routes an uncaught async handler rejection to the final error middleware', async () => {
  const app = express();
  app.get('/async-failure', async () => {
    throw new Error('sensitive exception text');
  });
  app.use(finalErrorHandler);
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const res = await request(app).get('/async-failure');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal Server Error' });
    expect(JSON.stringify(res.body)).not.toContain('sensitive exception text');
    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain('sensitive exception text');
  } finally {
    log.mockRestore();
  }
});
