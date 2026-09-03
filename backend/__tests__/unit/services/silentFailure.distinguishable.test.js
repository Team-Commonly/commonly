/**
 * TASK-099 — silent-failure sweep.
 *
 * The row's rule: every fallback that hides an error fails LOUD or fails
 * CLOSED with a log, never a template.
 *
 * The discriminator these tests encode, one level sharper than "does it
 * log": a fallback is a SILENT FAILURE iff the value it returns is reachable
 * on the SUCCESS path without being the documented fallback. `count: 0`,
 * `items: []`, `marked: 0`, `null` and `maxContextTokens: 0` are all ordinary
 * success values somewhere in this codebase, so returning one on failure
 * makes the failure unobservable by construction — no amount of logging at
 * the throw site changes what the CALLER can see.
 *
 * So each case below pairs the failure with its success TWIN and asserts the
 * two differ. A test that only exercised the failure arm would pass against
 * the very code these fixes replace.
 */

const path = require('path');

describe('TASK-099 — a failed fallback is distinguishable from its success twin', () => {
  describe('skillsCatalogService.loadCatalog', () => {
    const CATALOG = '/tmp/task099-catalog.json';
    let fs;
    let loadCatalog;
    let invalidateCache;

    beforeEach(() => {
      jest.resetModules();
      jest.doMock('fs', () => ({
        existsSync: jest.fn(),
        statSync: jest.fn(),
        readFileSync: jest.fn(),
      }));
      process.env.SKILLS_CATALOG_PATH = CATALOG;
      fs = require('fs');
      ({ loadCatalog, invalidateCache } = require('../../../services/skillsCatalogService'));
      invalidateCache();
    });

    afterEach(() => {
      delete process.env.SKILLS_CATALOG_PATH;
      jest.dontMock('fs');
    });

    it('returns an empty catalog when the file is legitimately absent', () => {
      fs.existsSync.mockReturnValue(false);
      expect(loadCatalog()).toEqual({ source: 'awesome', updatedAt: null, items: [] });
    });

    it('THROWS on an unreadable file instead of returning that same empty catalog', () => {
      fs.existsSync.mockReturnValue(true);
      fs.statSync.mockReturnValue({ mtimeMs: 1 });
      fs.readFileSync.mockImplementation(() => { throw new Error('EACCES'); });
      // Previously this returned `{ items: [] }` and GET /api/skills/catalog
      // answered 200 "no skills" for a catalog nobody could read.
      expect(() => loadCatalog()).toThrow(/unreadable/i);
    });

    it('THROWS on malformed JSON too — a parse failure is not an empty catalog', () => {
      fs.existsSync.mockReturnValue(true);
      fs.statSync.mockReturnValue({ mtimeMs: 2 });
      fs.readFileSync.mockReturnValue('{ not json');
      expect(() => loadCatalog()).toThrow(/unreadable/i);
    });
  });

  describe('telegramBridgeService.findLiveIntegration', () => {
    it('logs when the lookup THROWS, because null also means "no bridge here"', async () => {
      jest.resetModules();
      const Integration = { findOne: jest.fn(), findByIdAndUpdate: jest.fn() };
      jest.doMock('../../../models/Integration', () => Integration);
      jest.doMock('../../../services/telegramService', () => ({ sendMessage: jest.fn() }));

      const bridge = require('../../../services/telegramBridgeService');
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      // Success twin: no live bridge for this pod. Must stay quiet.
      Integration.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
      await bridge.relayAgentMessageToTelegram({
        podId: 'p1', agentUsername: 'a', displayName: 'A', content: '[DECISION] x',
      });
      const quietCalls = errSpy.mock.calls.filter((c) => String(c[0]).includes('findLiveIntegration'));
      expect(quietCalls).toHaveLength(0);

      // Failure arm: the store threw. Same `null`, but it must be audible.
      Integration.findOne.mockReturnValue({ lean: () => Promise.reject(new Error('mongo down')) });
      await bridge.relayAgentMessageToTelegram({
        podId: 'p1', agentUsername: 'a', displayName: 'A', content: '[DECISION] x',
      });
      const loudCalls = errSpy.mock.calls.filter((c) => String(c[0]).includes('findLiveIntegration'));
      expect(loudCalls).toHaveLength(1);

      errSpy.mockRestore();
    });
  });

  describe('agentAvatarService.parseDesignDescription', () => {
    it('tags the default design so a parse failure is not reported as a clean SVG', () => {
      jest.resetModules();
      const AgentAvatarService = require('../../../services/agentAvatarService');
      const svc = AgentAvatarService.default || AgentAvatarService;
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const parsed = svc.parseDesignDescription('noise {"style":"abstract","colors":["#111"]} tail');
      expect(parsed.fallbackReason).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();

      const fell = svc.parseDesignDescription('there is no json here at all');
      expect(fell.fallbackReason).toBe('design-parse-failed');
      expect(warn).toHaveBeenCalled();

      warn.mockRestore();
    });
  });

  describe('schedulerService.buildHeartbeatActivityHint', () => {
    // This hint is shipped VERBATIM into the heartbeat payload the agent reads,
    // so the pg arm's failure value does not stop at the service boundary — it
    // becomes a sentence in a prompt. `hasRecentActivity: false` asserted from a
    // failed read is the platform lying to every agent in the pod.
    const buildHint = ({ pgHint, posts = [] }) => {
      jest.resetModules();
      jest.doMock('../../../services/agentEventService', () => ({ enqueue: jest.fn() }));
      jest.doMock('../../../models/pg/Message', () => ({
        findActivityHint: jest.fn().mockResolvedValue(pgHint),
      }));
      jest.doMock('../../../models/Post', () => ({
        aggregate: jest.fn().mockResolvedValue(posts),
      }));
      const instance = require('../../../services/schedulerService');
      const SchedulerService = instance.constructor;
      return SchedulerService.buildHeartbeatActivityHint({ podId: 'p1', now: new Date() });
    };

    it('a genuinely quiet pod reads false', async () => {
      const hint = await buildHint({ pgHint: { count: 0, lastAt: null } });
      expect(hint.hasRecentActivity).toBe(false);
      expect(hint.messageCountUnavailable).toBe(false);
    });

    it('an unreadable message store reads null — unknown, not quiet', async () => {
      const hint = await buildHint({ pgHint: { count: 0, lastAt: null, unavailable: true } });
      expect(hint.hasRecentActivity).toBeNull();
      expect(hint.messageCountUnavailable).toBe(true);
    });

    it('a positive signal from the OTHER arm still reads true despite the failure', async () => {
      // Only a zero is unknowable. Posts answered, so activity is established
      // even though the message count is missing.
      const hint = await buildHint({
        pgHint: { count: 0, lastAt: null, unavailable: true },
        posts: [{ _id: null, count: 3, lastAt: new Date() }],
      });
      expect(hint.hasRecentActivity).toBe(true);
      expect(hint.messageCountUnavailable).toBe(true);
    });
  });
});
