const http = require('http');
const express = require('express');
const request = require('supertest');
const { loopbackUrl } = require('../../utils/supertestLoopback');

const listen = (server, ...address) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(...address, () => {
    server.off('error', reject);
    resolve(server);
  });
});
const close = (server) => new Promise((resolve) => { server.close(resolve); });

describe('supertest reaches the server it bound', () => {
  const macOnly = process.platform === 'darwin' ? test : test.skip;

  macOnly('a listener holding the port on 127.0.0.1 does not answer', async () => {
    const stranger = await listen(
      http.createServer((req, res) => { res.statusCode = 404; res.end('provider relay: 404'); }),
      0,
      '127.0.0.1',
    );
    try {
      const app = express();
      app.get('/mine', (req, res) => res.json({ mine: true }));
      const mine = await listen(http.createServer(app), stranger.address().port);
      try {
        const res = await request(mine).get('/mine');
        expect([res.status, res.body]).toEqual([200, { mine: true }]);
      } finally {
        await close(mine);
      }
    } finally {
      await close(stranger);
    }
  });

  test('a server bound to 127.0.0.1 is still called there', async () => {
    const app = express();
    app.get('/mine', (req, res) => res.json({ mine: true }));
    const mine = await listen(http.createServer(app), 0, '127.0.0.1');

    try {
      const res = await request(mine).get('/mine');
      expect(res.status).toBe(200);
    } finally {
      await close(mine);
    }
  });

  test('only a macOS wildcard bind changes the address', () => {
    const url = 'http://127.0.0.1:5000/x';
    expect(loopbackUrl(url, 'IPv6', 'darwin')).toBe('http://[::1]:5000/x');
    expect(loopbackUrl(url, 'IPv4', 'darwin')).toBe(url);
    expect(loopbackUrl(url, 'IPv6', 'linux')).toBe(url);
  });
});
