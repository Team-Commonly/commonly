// ADR-002 Phase 1 — GET route covers both the driver-hit path and the
// legacy File.data fallback for pre-ADR-002 records.

const request = require('supertest');
const express = require('express');
const { Readable } = require('stream');

const mockStore = {
  capabilities: { name: 'mongo', maxObjectBytes: 10 * 1024 * 1024 },
  get: jest.fn(),
  put: jest.fn(),
  delete: jest.fn(),
};

jest.mock('../../../services/objectStore', () => ({
  getObjectStore: () => mockStore,
  __resetObjectStoreForTests: jest.fn(),
}));

jest.mock('../../../models/File', () => ({
  findByFileName: jest.fn(),
}));

jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));

jest.mock('../../../middleware/auth', () => (req, res, next) => next());

const mockCanReadAttachment = jest.fn();
jest.mock('../../../services/attachmentAccess', () => ({
  DEFAULT_TOKEN_TTL_SECONDS: 300,
  canReadAttachment: (...args) => mockCanReadAttachment(...args),
  signAttachmentToken: jest.fn(),
  verifyAttachmentToken: jest.fn(),
}));

const mockAgentRuntimeAuth = jest.fn();
jest.mock('../../../middleware/agentRuntimeAuth', () => (...args) => mockAgentRuntimeAuth(...args));

jest.mock('../../../models/User', () => ({ findById: jest.fn() }));

// The PPTX preview shells out to officecli; a stand-in writes the HTML file
// officecli would and prints its path, so the success path is reachable.
const mockSpawn = jest.fn();
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: (...args) => mockSpawn(...args),
}));

const File = require('../../../models/File');
const User = require('../../../models/User');
const jwt = require('jsonwebtoken');
const routes = require('../../../routes/uploads');

describe('uploads GET /:fileName (ADR-002 Phase 1)', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/uploads', routes);

  beforeEach(() => {
    mockStore.get.mockReset();
    mockStore.put.mockReset();
    mockStore.delete.mockReset();
    File.findByFileName.mockReset();
    mockCanReadAttachment.mockReset();
    mockAgentRuntimeAuth.mockReset().mockImplementation((req, _res, next) => {
      req.agentUser = { _id: 'agent-user' };
      next();
    });
  });

  it('streams bytes from the driver when the key is present', async () => {
    mockStore.get.mockResolvedValue({
      stream: Readable.from(Buffer.from('hello')),
      mime: 'image/png',
      size: 5,
    });

    const res = await request(app)
      .get('/api/uploads/new.png')
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body)).toEqual(
      Buffer.from('hello'),
    );
    expect(mockStore.get).toHaveBeenCalledWith('new.png');
    // authorizePodFile now consults File.findByFileName to decide whether the
    // file is pod-scoped (requires auth) or public (un-scoped — served as here,
    // since the mock returns no record → no podId → public).
    expect(File.findByFileName).toHaveBeenCalledWith('new.png');
  });

  // TASK-315: the served type comes from the allowlisted extension, never the
  // type the uploading client declared, and the browser may not sniff past it.
  describe('served headers', () => {
    const fromDriver = (mime) => mockStore.get.mockResolvedValue({
      // '{}' parses as JSON, which supertest does for the json row.
      stream: Readable.from(Buffer.from('{}')), mime, size: 2,
    });

    it.each([
      ['photo.png', 'image/png', 'inline'],
      ['notes.TXT', 'text/plain; charset=utf-8', 'inline'],
      ['readme.md', 'text/plain; charset=utf-8', 'inline'],
      ['rows.csv', 'text/csv; charset=utf-8', 'inline'],
      ['data.json', 'application/json; charset=utf-8', 'inline'],
      ['paper.pdf', 'application/pdf', 'inline'],
      ['shot.webp', 'image/webp', 'inline'],
      ['diagram.svg', 'image/svg+xml', 'attachment'],
      ['deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'attachment'],
      ['bundle.zip', 'application/zip', 'attachment'],
      ['page.html', 'application/octet-stream', 'attachment'],
      ['noextension', 'application/octet-stream', 'attachment'],
    ])('%s stored as text/html is served as %s, %s, nosniff', async (name, type, disposition) => {
      fromDriver('text/html');
      const res = await request(app).get(`/api/uploads/${name}`).expect(200);
      expect(res.headers['content-type']).toBe(type);
      expect(res.headers['content-disposition']).toBe(disposition);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      // Opened straight from this origin, a file runs with no origin and loads
      // nothing. PDF keeps its viewer, which Chrome refuses under a sandbox.
      if (name === 'paper.pdf') expect(res.headers['content-security-policy']).toBeUndefined();
      else expect(res.headers['content-security-policy']).toMatch(/(^|; )sandbox$/);
    });

    it('a legacy inline record is served by its extension, not its stored type', async () => {
      mockStore.get.mockResolvedValue(null);
      File.findByFileName.mockResolvedValue({ data: Buffer.from('<p>x</p>'), contentType: 'text/html' });
      const res = await request(app).get('/api/uploads/old.txt').expect(200);
      expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(res.headers['content-disposition']).toBe('inline');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });
  });

  // TASK-133 (d): the Bearer branch of authorizePodFile verified the signature and
  // the ACL and never read the row, so a bot user's session read pod-scoped
  // attachments as if it were the person the row was converted from.
  describe('a Bearer session is verified against the live row', () => {
    const sessionRow = (value) => ({ select: () => ({ lean: async () => value }) });

    beforeEach(() => {
      File.findByFileName.mockResolvedValue({ podId: 'pod-1' });
      mockStore.get.mockResolvedValue({
        stream: Readable.from(Buffer.from('bytes')),
        mime: 'text/plain',
        size: 5,
      });
    });

    it('serves a pod-scoped file to a human session', async () => {
      jwt.verify.mockReturnValue({ id: 'human-1' });
      User.findById.mockReturnValue(sessionRow({ banned: false, isBot: false }));
      mockCanReadAttachment.mockResolvedValue(true);

      await request(app)
        .get('/api/uploads/secret.txt')
        .set('Authorization', 'Bearer user-session')
        .expect(200);
    });

    it('refuses an agent session even when the ACL would allow the bot user', async () => {
      jwt.verify.mockReturnValue({ id: 'bot-1' });
      User.findById.mockReturnValue(sessionRow({ banned: false, isBot: true }));
      mockCanReadAttachment.mockResolvedValue(true);

      await request(app)
        .get('/api/uploads/secret.txt')
        .set('Authorization', 'Bearer user-session')
        .expect(403);

      // The row read comes first, so a permissive ACL cannot reach past it.
      expect(mockCanReadAttachment).not.toHaveBeenCalled();
    });

    it('refuses a banned session', async () => {
      jwt.verify.mockReturnValue({ id: 'human-2' });
      User.findById.mockReturnValue(sessionRow({ banned: true, isBot: false }));
      mockCanReadAttachment.mockResolvedValue(true);

      await request(app)
        .get('/api/uploads/secret.txt')
        .set('Authorization', 'Bearer user-session')
        .expect(403);
    });
  });

  it('falls back to legacy File.data when the driver returns null', async () => {
    mockStore.get.mockResolvedValue(null);
    File.findByFileName.mockResolvedValue({
      data: Buffer.from('legacy-bytes'),
      contentType: 'image/jpeg',
    });

    const res = await request(app).get('/api/uploads/legacy.jpg').expect(200);
    expect(res.headers['content-type']).toMatch(/image\/jpeg/);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body.toString()).toBe('legacy-bytes');
    expect(File.findByFileName).toHaveBeenCalledWith('legacy.jpg');
  });

  it('returns 404 when neither driver nor legacy store has the key', async () => {
    mockStore.get.mockResolvedValue(null);
    File.findByFileName.mockResolvedValue(null);
    await request(app).get('/api/uploads/missing').expect(404);
  });

  it('returns 404 when the legacy record exists but has no data (metadata-only)', async () => {
    mockStore.get.mockResolvedValue(null);
    File.findByFileName.mockResolvedValue({ data: Buffer.alloc(0), contentType: 'image/png' });
    await request(app).get('/api/uploads/empty.png').expect(404);
  });

  it('returns 500 when the driver throws', async () => {
    mockStore.get.mockRejectedValue(new Error('boom'));
    await request(app).get('/api/uploads/explode').expect(500);
  });

  it('allows a runtime agent to read a pod attachment when its bot user passes the ACL', async () => {
    File.findByFileName.mockResolvedValue({ podId: 'private-pod' });
    mockCanReadAttachment.mockResolvedValue(true);
    mockStore.get.mockResolvedValue({
      stream: Readable.from(Buffer.from('agent-readable')),
      mime: 'text/plain',
      size: 14,
    });

    const res = await request(app)
      .get('/api/uploads/private.txt')
      .set('Authorization', 'Bearer cm_agent_runtime-token')
      .expect(200);

    expect(res.text).toBe('agent-readable');
    expect(mockAgentRuntimeAuth).toHaveBeenCalledTimes(1);
    expect(mockCanReadAttachment).toHaveBeenCalledWith('private.txt', 'agent-user');
  });

  it('keeps a runtime agent out of a pod attachment when the ACL denies its bot user', async () => {
    File.findByFileName.mockResolvedValue({ podId: 'private-pod' });
    mockCanReadAttachment.mockResolvedValue(false);

    await request(app)
      .get('/api/uploads/private.txt')
      .set('Authorization', 'Bearer cm_agent_runtime-token')
      .expect(403);

    expect(mockCanReadAttachment).toHaveBeenCalledWith('private.txt', 'agent-user');
    expect(mockStore.get).not.toHaveBeenCalled();
  });

  it('uses the same runtime-agent authorization for a private PPTX preview', async () => {
    File.findByFileName.mockResolvedValue({ podId: 'private-pod' });
    mockCanReadAttachment.mockResolvedValue(true);
    mockStore.get.mockResolvedValue(null);

    // No PPTX bytes are needed: the 404 proves the agent cleared the shared
    // authorization helper and reached storage instead of being denied 403.
    await request(app)
      .get('/api/uploads/private.pptx/preview-pptx-html')
      .set('Authorization', 'Bearer cm_agent_runtime-token')
      .expect(404);

    expect(mockAgentRuntimeAuth).toHaveBeenCalledTimes(1);
    expect(mockCanReadAttachment).toHaveBeenCalledWith('private.pptx', 'agent-user');
  });

  it('serves a rendered PPTX preview as html with nosniff', async () => {
    const { EventEmitter } = require('events');
    const fs = require('fs');
    const path = require('path');
    mockSpawn.mockImplementation((_cmd, _args, { cwd, env }) => {
      expect(env.TMPDIR).toBe(cwd);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => {
        const out = path.join(cwd, 'deck.html');
        fs.writeFileSync(out, '<html>deck</html>');
        child.stdout.emit('data', Buffer.from(`${out}\n`));
        child.emit('close', 0);
      });
      return child;
    });
    mockStore.get.mockResolvedValue({ stream: Readable.from(Buffer.from('pptx')), mime: 'x', size: 4 });

    const res = await request(app).get('/api/uploads/deck.pptx/preview-pptx-html').expect(200);
    expect(res.text).toBe('<html>deck</html>');
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // The page is built from the deck's content, so it runs with no origin of
    // its own: scripts for the viewer, never this origin's.
    const csp = res.headers['content-security-policy'];
    expect(csp).toMatch(/^sandbox allow-scripts; /);
    expect(csp).not.toMatch(/allow-same-origin/);
    expect(csp).toMatch(/connect-src 'none'/);
    expect(csp).toMatch(/form-action 'none'/);
  });

  describe('a render is bounded', () => {
    const { EventEmitter } = require('events');
    const hungChild = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = jest.fn(() => setImmediate(() => child.emit('close', null)));
      return child;
    };
    const deck = () => mockStore.get.mockResolvedValue({ stream: Readable.from(Buffer.from('pptx')), mime: 'x', size: 4 });
    const until = async (check) => {
      for (let i = 0; i < 200 && !check(); i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setImmediate(r));
      }
    };

    it('kills officecli at the deadline instead of leaving it running', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
      try {
        const child = hungChild();
        mockSpawn.mockImplementation(() => child);
        deck();
        const pending = request(app).get('/api/uploads/deck.pptx/preview-pptx-html');
        const done = pending.then((res) => res);
        await until(() => mockSpawn.mock.calls.length > 0);
        jest.advanceTimersByTime(30_000);
        const res = await done;
        expect(res.status).toBe(500);
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      } finally {
        jest.useRealTimers();
      }
    });

    it('resolves after a short grace when the killed process never closes its pipes', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
      try {
        const child = hungChild();
        child.kill = jest.fn(() => setImmediate(() => child.emit('exit', null, 'SIGKILL')));
        mockSpawn.mockImplementation(() => child);
        deck();
        const done = request(app).get('/api/uploads/deck.pptx/preview-pptx-html').then((res) => res);
        await until(() => mockSpawn.mock.calls.length > 0);
        jest.advanceTimersByTime(30_000);
        await until(() => child.kill.mock.calls.length > 0);
        jest.advanceTimersByTime(3_000);
        const res = await done;
        expect(res.status).toBe(500);
        // The slot came back: the next render spawns rather than answering 503.
        jest.useRealTimers();
        const next = hungChild();
        mockSpawn.mockImplementation(() => {
          setImmediate(() => next.emit('close', 1));
          return next;
        });
        deck();
        expect((await request(app).get('/api/uploads/deck.pptx/preview-pptx-html')).status).toBe(500);
        expect(mockSpawn).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('answers 503 past the concurrent render cap instead of spawning more', async () => {
      const children = [];
      mockSpawn.mockImplementation(() => {
        const child = hungChild();
        children.push(child);
        return child;
      });
      deck();
      const first = request(app).get('/api/uploads/a.pptx/preview-pptx-html').then((r) => r);
      await until(() => children.length === 1);
      deck();
      const second = request(app).get('/api/uploads/b.pptx/preview-pptx-html').then((r) => r);
      await until(() => children.length === 2);
      mockStore.get.mockClear();
      const third = await request(app).get('/api/uploads/c.pptx/preview-pptx-html');
      expect(third.status).toBe(503);
      // Refused before the deck was read into memory.
      expect(mockStore.get).not.toHaveBeenCalled();
      expect(mockSpawn).toHaveBeenCalledTimes(2);
      children.forEach((child) => child.emit('close', 1));
      await Promise.all([first, second]);
    });

    it('does not read back a path outside the temp dir', async () => {
      mockSpawn.mockImplementation(() => {
        const child = hungChild();
        setImmediate(() => {
          child.stdout.emit('data', Buffer.from(`${require('os').tmpdir()}/other-render.html\n`));
          child.emit('close', 0);
        });
        return child;
      });
      deck();
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const res = await request(app).get('/api/uploads/deck.pptx/preview-pptx-html').expect(500);
      // A render outside this request's own directory is never read, and the
      // reason is logged, not returned.
      expect(res.body).toEqual({ msg: 'Could not render preview' });
      expect(warn).toHaveBeenCalledWith(expect.any(String), 'unexpected output path');
      warn.mockRestore();
    });
  });
});
