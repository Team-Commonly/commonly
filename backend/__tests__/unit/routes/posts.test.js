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
}));

jest.mock('../../../middleware/auth', () => (req, res, next) => next());

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
});
