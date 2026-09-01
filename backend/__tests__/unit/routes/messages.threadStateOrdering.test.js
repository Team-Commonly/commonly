/**
 * `GET /threads/state` is protected by SEGMENT COUNT, not by ordering.
 *
 * The comment above the registration says it is "registered above the greedy
 * `GET /:podId` on purpose". It is not: `/:podId` is registered at :85 and
 * `/threads/state` at :152, sixty-seven lines BELOW it. Express matches in
 * registration order, so if ordering were the protection this route would
 * already be dead.
 *
 * What actually protects it is that `/:podId` compiles to a single-segment
 * pattern and `/threads/state` is two segments. That is the load-bearing fact
 * the comment treats as incidental ("does not currently collide"), and the
 * failure mode is quiet: rename this route to one segment and `getMessages`
 * swallows it, under `auth` rather than `dualAuth` — so every agent caller
 * gets a 401 for a route that looks registered and reads correct.
 *
 * Executing rather than grepping the source, per checklist rule 18: "does this
 * path reach that handler" is behavioural, and only the real router can answer
 * it. The controllers are stubbed to identify themselves; the router, its
 * registration order, and its path patterns are the real ones.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../../../middleware/auth', () => (req, res, next) => next());
jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => next());

const hit = (name) => (req, res) => res.json({ handler: name });

jest.mock('../../../controllers/messageController', () => ({
  getMessages: (req, res) => res.json({ handler: 'getMessages', podId: req.params.podId }),
  createMessage: hit('createMessage'),
  deleteMessage: hit('deleteMessage'),
}));
jest.mock('../../../controllers/reactionController', () => ({
  addReaction: hit('addReaction'),
  removeReaction: hit('removeReaction'),
}));
jest.mock('../../../controllers/threadStateController', () => ({
  listThreadState: hit('listThreadState'),
  followThread: hit('followThread'),
  unfollowThread: hit('unfollowThread'),
  setThreadCollapsed: hit('setThreadCollapsed'),
}));

const messagesRouter = require('../../../routes/messages');

const app = express();
app.use(express.json());
app.use('/api/messages', messagesRouter);

describe('the greedy single-segment route is registered FIRST, and that is fine', () => {
  it('GET /threads/state reaches listThreadState, not getMessages', async () => {
    const res = await request(app).get('/api/messages/threads/state?podId=p1');
    expect(res.body.handler).toBe('listThreadState');
  });

  it('CONTROL: a single-segment path DOES land on the greedy route', async () => {
    // Proves the assertion above is discriminating — the greedy route is live,
    // reachable, and would have taken the request if the pattern let it.
    const res = await request(app).get('/api/messages/threads');
    expect(res.body).toEqual({ handler: 'getMessages', podId: 'threads' });
  });

  it('so a rename to one segment would be silently swallowed', async () => {
    // The exact latent bug the comment mis-attributes to ordering. `/threadstate`
    // is what a well-meaning tidy-up produces, and it is already taken.
    const res = await request(app).get('/api/messages/threadstate');
    expect(res.body.handler).toBe('getMessages');
    expect(res.body.handler).not.toBe('listThreadState');
  });
});

describe('the per-message thread toggles are below the greedy route too', () => {
  it.each([
    ['post', '/api/messages/42/follow', 'followThread'],
    ['delete', '/api/messages/42/follow', 'unfollowThread'],
    ['put', '/api/messages/42/collapsed', 'setThreadCollapsed'],
  ])('%s %s reaches %s', async (method, path, handler) => {
    // These are two segments as well, and they carry a VERB the greedy route
    // does not register — GET/POST /:podId and DELETE /:id. Two independent
    // reasons they survive, neither of them ordering.
    const res = await request(app)[method](path);
    expect(res.body.handler).toBe(handler);
  });
});
