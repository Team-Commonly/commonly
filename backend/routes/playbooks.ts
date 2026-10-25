import express from 'express';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import { cloudflareIpRateLimitKeyGenerator } from '../middleware/ipRateLimit';
import { PlaybookError } from '../services/playbooks/definition';
import { createOffPlaybook, editPlaybook, setPlaybookOn, requirePlaybookHuman,
  listPlaybooks, listPlaybookRuns, playbookOptions } from '../services/playbooks/store';
import { runPlaybookManually, askAgainForPlaybookPoint } from '../services/playbooks/runner';
import { loadPlaybookPoint } from '../services/playbooks/rulings';
import { listPlaybookGallery, copyGalleryPlaybook } from '../services/playbooks/gallery';

const auth = require('../middleware/auth');
const router = express.Router();
const limit = rateLimit({ windowMs: 60_000, max: 90, standardHeaders: true, legacyHeaders: false,
  keyGenerator: cloudflareIpRateLimitKeyGenerator });
interface HumanRequest extends express.Request { userId?: string }
const caller = (req: HumanRequest) => String(req.userId || req.user?.id || '');
const failure = (error: unknown, res: express.Response) => {
  if (error instanceof PlaybookError) return res.status(error.status).json({ error: error.code, message: error.message });
  console.error('[playbooks] request failed:', error instanceof Error ? error.name : 'unknown');
  return res.status(503).json({ error: 'playbook_unavailable', message: 'Playbooks unavailable. Retry shortly.' });
};
const human = async (req: HumanRequest, res: express.Response, next: express.NextFunction) => {
  try {
    if (!caller(req)) return res.status(401).json({ error: 'unauthorized' });
    if (!mongoose.isObjectIdOrHexString(req.params.podId)
      || (req.params.installationId && !mongoose.isObjectIdOrHexString(req.params.installationId))) {
      return res.status(404).json({ error: 'playbook_not_found' });
    }
    req.params.podId = req.params.podId.toLowerCase();
    if (req.params.installationId) req.params.installationId = req.params.installationId.toLowerCase();
    await requirePlaybookHuman(req.params.podId, caller(req));
    res.set('Cache-Control', 'no-store');
    return next();
  } catch (error) { return failure(error, res); }
};
const bodyKeys = (body: unknown, keys: string[]): body is Record<string, unknown> => body !== null && body !== undefined
  && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every((key) => keys.includes(key));

router.get('/:podId/playbooks', limit, auth, human, async (req: HumanRequest, res) => {
  try { return res.json({ playbooks: await listPlaybooks(req.params.podId, caller(req)) }); }
  catch (error) { return failure(error, res); }
});
router.get('/:podId/playbooks/options', limit, auth, human, async (req: HumanRequest, res) => {
  try { return res.json(await playbookOptions(req.params.podId, caller(req))); }
  catch (error) { return failure(error, res); }
});
router.get('/:podId/playbooks/gallery', limit, auth, human, async (req: HumanRequest, res) => {
  try { return res.json({ playbooks: await listPlaybookGallery(req.params.podId, caller(req)) }); }
  catch (error) { return failure(error, res); }
});
router.post('/:podId/playbooks/gallery/:seedId', limit, auth, human, async (req: HumanRequest, res) => {
  try {
    if (!bodyKeys(req.body, ['timezone']) || (req.body.timezone !== undefined && typeof req.body.timezone !== 'string')) {
      return res.status(400).json({ error: 'invalid_schedule', message: 'Choose your timezone' });
    }
    const row = await copyGalleryPlaybook(req.params.podId, caller(req), req.params.seedId, req.body.timezone as string);
    return res.status(201).json({ id: String(row._id), on: false });
  } catch (error) { return failure(error, res); }
});
router.post('/:podId/playbooks', limit, auth, human, async (req: HumanRequest, res) => {
  try {
    const row = await createOffPlaybook(req.params.podId, caller(req), req.body);
    return res.status(201).json({ id: String(row._id), on: false });
  } catch (error) { return failure(error, res); }
});
router.put('/:podId/playbooks/:installationId', limit, auth, human, async (req: HumanRequest, res) => {
  try {
    const row = await editPlaybook(req.params.podId, caller(req), req.params.installationId, req.body);
    return res.json({ id: String(row._id), on: false });
  } catch (error) { return failure(error, res); }
});
router.post('/:podId/playbooks/:installationId/state', limit, auth, human, async (req: HumanRequest, res) => {
  try {
    if (!bodyKeys(req.body, ['on', 'bindings']) || typeof req.body.on !== 'boolean') {
      return res.status(400).json({ error: 'invalid_state', message: 'Provide on and role bindings' });
    }
    const row = await setPlaybookOn(req.params.podId, caller(req), req.params.installationId,
      req.body.bindings as Record<string, string>, req.body.on);
    return res.json({ id: String(row._id), on: row.status === 'active' });
  } catch (error) { return failure(error, res); }
});
router.post('/:podId/playbooks/:installationId/run', limit, auth, human, async (req: HumanRequest, res) => {
  try {
    if (!bodyKeys(req.body, ['input', 'requestId']) || (req.body.input !== undefined && typeof req.body.input !== 'string')
      || (req.body.requestId !== undefined && typeof req.body.requestId !== 'string')) {
      return res.status(400).json({ error: 'invalid_trigger', message: 'Provide Run input and a request ID' });
    }
    const result = await runPlaybookManually({ podId: req.params.podId, userId: caller(req),
      installationId: req.params.installationId, input: (req.body.input as string) || '',
      requestId: req.body.requestId as string | undefined });
    return res.json({ runTaskId: result.run.taskId, stepTaskId: result.step?.taskId || null });
  } catch (error) { return failure(error, res); }
});
router.get('/:podId/playbooks/:installationId/runs', limit, auth, human, async (req: HumanRequest, res) => {
  try { return res.json({ runs: await listPlaybookRuns(req.params.podId, caller(req), req.params.installationId) }); }
  catch (error) { return failure(error, res); }
});
router.post('/:podId/playbooks/:installationId/steps/:taskId/ask-again', limit, auth, human,
  async (req: HumanRequest, res) => {
    try {
      const point = await loadPlaybookPoint(req.params.podId, req.params.taskId);
      if (point.installationId !== req.params.installationId) return res.status(404).json({ error: 'point_not_found' });
      const row = await askAgainForPlaybookPoint(req.params.podId, req.params.taskId, caller(req));
      return res.json({ taskId: row.taskId, approvalId: String(row.ruling!.approvalId) });
    } catch (error) { return failure(error, res); }
  });
module.exports = router;
