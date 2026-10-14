const request = require('supertest');
const express = require('express');

jest.mock('../../../controllers/postController', () => ({
  createPost: jest.fn((req, res) => res.status(201).end()),
  getPosts: jest.fn((req, res) => res.status(200).end()),
  getPostById: jest.fn((req, res) => res.status(200).end()),
  addComment: jest.fn((req, res) => res.status(200).end()),
  searchPosts: jest.fn((req, res) => res.status(200).end()),
  likePost: jest.fn((req, res) => res.status(200).end()),
  deletePost: jest.fn((req, res) => res.status(200).end()),
  deleteComment: jest.fn((req, res) => res.status(200).end()),
  followThread: jest.fn((req, res) => res.status(200).end()),
  unfollowThread: jest.fn((req, res) => res.status(200).end()),
  getFollowedThreads: jest.fn((req, res) => res.status(200).end()),
  toggleAgentComments: jest.fn((req, res) => res.status(200).end()),
}));

// Pass-through auth, except a request carrying `x-refuse` is refused, which
// lets the limiter-order test see whether the limiter answered first.
jest.mock('../../../middleware/auth', () => (req, res, next) => (
  req.get('x-refuse') ? res.status(401).json({ msg: 'refused' }) : next()
));

const routes = require('../../../routes/posts');
const controllers = require('../../../controllers/postController');

describe('posts routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/posts', routes);

  it('POST /api/posts calls createPost', async () => {
    await request(app).post('/api/posts').send({}).expect(201);
    expect(controllers.createPost).toHaveBeenCalled();
  });

  it('GET /api/posts/following/threads calls getFollowedThreads', async () => {
    await request(app).get('/api/posts/following/threads').expect(200);
    expect(controllers.getFollowedThreads).toHaveBeenCalled();
  });

  it('POST /api/posts/:id/follow calls followThread', async () => {
    await request(app).post('/api/posts/abc123/follow').send({}).expect(200);
    expect(controllers.followThread).toHaveBeenCalled();
  });

  it('DELETE /api/posts/:id/follow calls unfollowThread', async () => {
    await request(app).delete('/api/posts/abc123/follow').expect(200);
    expect(controllers.unfollowThread).toHaveBeenCalled();
  });
});

// Presence, not timing: the limiter's standard headers name the budget that
// answered. Reads share a 240/min budget and writes a 60/min one, per token.
describe('posts routes rate limits', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/posts', routes);

  const READS = [
    ['get', '/api/posts'],
    ['get', '/api/posts/search'],
    ['get', '/api/posts/following/threads'],
    ['get', '/api/posts/abc123'],
  ];
  const WRITES = [
    ['post', '/api/posts'],
    ['post', '/api/posts/abc123/comments'],
    ['post', '/api/posts/abc123/follow'],
    ['delete', '/api/posts/abc123/follow'],
    ['post', '/api/posts/abc123/like'],
    ['delete', '/api/posts/abc123'],
    ['delete', '/api/posts/abc123/comments/c1'],
    ['patch', '/api/posts/abc123/agent-comments'],
  ];

  it.each(READS)('%s %s carries the read limiter', async (verb, path) => {
    const res = await request(app)[verb](path);
    expect(res.headers['ratelimit-limit']).toBe('240');
  });

  it.each(WRITES)('%s %s carries the write limiter', async (verb, path) => {
    const res = await request(app)[verb](path).send({});
    expect(res.headers['ratelimit-limit']).toBe('60');
  });

  it('runs the limiter ahead of auth, so a refused request is still counted', async () => {
    const res = await request(app).get('/api/posts').set('x-refuse', '1').expect(401);
    expect(res.headers['ratelimit-limit']).toBe('240');
  });
});
