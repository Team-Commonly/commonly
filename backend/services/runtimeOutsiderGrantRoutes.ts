/** Runtime-token route policy for TASK-213 A. Keep this list exhaustive: an
 * unlisted acceptor fails closed while an outsider-writable grant is live. */
import type { Request } from 'express';
import Post from '../models/Post';
import AgentAsk from '../models/AgentAsk';
import AgentEnsembleState from '../models/AgentEnsembleState';
import Message from '../models/pg/Message';

type RouteClass = 'read' | 'pod_write' | 'grant' | 'own_state' | 'outward';
type PodResolver = (req: Request) => Promise<string | null>;
interface RouteRule { routeClass: RouteClass; resolvePod?: PodResolver }
const podParam: PodResolver = async (req) => String(req.params.podId || '') || null;
const bodyPod: PodResolver = async (req) => String(req.body?.podId || '') || null;
const postPod: PodResolver = async (req) => {
  const post = await Post.findById(req.params.threadId).select('podId').lean();
  return post?.podId ? String(post.podId) : null;
};
const messagePod: PodResolver = async (req) => {
  const message = await Message.findById(String(req.params.messageId || ''));
  return message?.pod_id ? String(message.pod_id) : null;
};
const askPod: PodResolver = async (req) => {
  const ask = await AgentAsk.findOne({ requestId: req.params.requestId }).select('podId').lean();
  return ask?.podId ? String(ask.podId) : null;
};
const ensemblePod: PodResolver = async (req) => {
  const state = await AgentEnsembleState.findById(req.body?.ensembleId).select('podId').lean();
  return state?.podId ? String(state.podId) : null;
};
const privateMemory = (req: Request): boolean => {
  const { content, sections, mode, sourceRuntime } = req.body || {};
  // Legacy content mirrors into long_term, and a full sync can retain or
  // restore shared sections. sourceRuntime is visible to other agents through
  // the shared-memory read even when every supplied section is private.
  if (content !== undefined || sourceRuntime !== undefined || mode === 'full'
      || !sections || typeof sections !== 'object'
      || Array.isArray(sections)) return false;
  return Object.values(sections).every((section) => {
    if (Array.isArray(section)) return section.every((entry) => entry?.visibility === 'private');
    return section && typeof section === 'object' && (section as { visibility?: unknown }).visibility === 'private';
  });
};

const rules: Record<string, RouteRule> = {};
const add = (base: string, routeClass: RouteClass, methodsAndPaths: string[], resolvePod?: PodResolver) => {
  methodsAndPaths.forEach((entry) => { rules[`${base} ${entry}`] = { routeClass, resolvePod }; });
};
const runtime = '/api/agents/runtime';
add(runtime, 'read', [
  'GET /installations', 'GET /events', 'GET /pods/:podId/context', 'GET /pods/:podId/messages',
  'GET /pods/:podId/files', 'GET /pods/:podId/files/:fileName/content', 'GET /pods/:podId/posts',
  'GET /memory', 'GET /pods', 'GET /pods/:podId/integrations',
  'GET /pods/:podId/skills', 'GET /pods/:podId/send-freshness',
  'GET /pods/:podId/integrations/:integrationId/messages', 'GET /pods/:podId/social-policy',
  'GET /memory/shared/:agentName/:instanceId?',
]);
add(runtime, 'own_state', ['POST /events/:id/ack', 'POST /pods/:podId/skill-load']);
// A lease renewal, the seat's own model controls (a page-issued key may change
// only its own BYO installations), and its own read cursor: none reaches anyone else.
add(runtime, 'own_state', ['POST /events/renew', 'PATCH /configuration', 'POST /pods/:podId/catch-up']);
add(runtime, 'pod_write', [
  'POST /pods/:podId/typing', 'POST /pods/:podId/messages', 'POST /pods/:podId/propose-action',
  'POST /pods/:podId/summaries', 'POST /pods/:podId/ask', 'POST /pods/:podId/uploads',
  'POST /pods/:podId/hooks',
], podParam);
add(runtime, 'pod_write', ['POST /messages/:messageId/claim', 'POST /posts', 'POST /decisions'], bodyPod);
// Release looks up the message by ID; its handler ignores a caller-supplied podId.
add(runtime, 'pod_write', ['DELETE /messages/:messageId/claim'], messagePod);
add(runtime, 'pod_write', ['POST /threads/:threadId/comments'], postPod);
add(runtime, 'pod_write', ['POST /asks/:requestId/respond'], askPod);
add(runtime, 'outward', [
  'POST /room', 'POST /agent-dm', 'POST /pods', 'POST /pods/:podId/self-install',
  'POST /pods/:podId/integrations/:integrationId/publish',
]);
add(runtime, 'pod_write', ['PUT /memory', 'POST /memory/sync']); // private-only special case below
const spawn = `${runtime}/spawn-credentials`;
// Credential maintenance reaches only the authenticated seat. A minted child
// resolves the same agent identity in agentRuntimeAuth and inherits this check.
add(spawn, 'own_state', ['GET /policy', 'POST /', 'POST /:id/renew', 'POST /revoke-orphans', 'DELETE /:id']);
// The handler ignores :podId and writes to the ensemble named in the body.
add('/api/pods', 'pod_write', ['POST /:podId/ensemble/response'], ensemblePod);
add('/api/pods', 'read', ['GET /:podId/record', 'GET /:podId/record/tasks/:taskId']);
add('/api/messages', 'read', ['GET /threads/state']);
add('/api/messages', 'pod_write', [
  'POST /:messageId/reactions', 'DELETE /:messageId/reactions/:emoji',
  'POST /:messageId/follow', 'DELETE /:messageId/follow', 'PUT /:messageId/collapsed',
], messagePod);
add('/api/artifacts', 'read', ['GET /']);
add('/api/uploads', 'read', ['GET /:fileName', 'GET /:fileName/preview-pptx-html']);
add('/api/github', 'read', ['GET /issues']);
add('/api/github', 'outward', ['POST /issues', 'POST /issues/:number/comment', 'POST /issues/:number/close']);
add('/api/v1/tasks', 'read', ['GET /:podId']);
add('/api/v1/tasks', 'pod_write', [
  'POST /:podId', 'POST /:podId/:taskId/claim', 'POST /:podId/:taskId/complete',
  'POST /:podId/:taskId/updates', 'PATCH /:podId/:taskId', 'POST /:podId/:taskId/watch',
], podParam);
add('/api/grants', 'grant', ['POST /:grantId/attenuate', 'GET /:grantId/calls', 'GET /:grantId']);
add('/api/mcp/grants', 'grant', ['POST /:grantId']);

export const runtimeOutsiderGrantRouteKeys = Object.keys(rules);

export const classifyRuntimeOutsiderGrantRoute = async (req: Request): Promise<{
  routeClass: RouteClass | 'unknown'; podId: string | null;
}> => {
  const key = `${req.baseUrl} ${req.method.toUpperCase()} ${req.route?.path || ''}`;
  const rule = rules[key];
  if (!rule) return { routeClass: 'unknown', podId: null };
  if ((req.route?.path === '/memory' || req.route?.path === '/memory/sync')
      && rule.routeClass === 'pod_write') {
    return { routeClass: privateMemory(req) ? 'read' : 'outward', podId: null };
  }
  const podId = rule.resolvePod ? await rule.resolvePod(req) : null;
  if (!podId && req.baseUrl === runtime
      && (req.route?.path === '/posts' || req.route?.path === '/threads/:threadId/comments')) {
    return { routeClass: 'outward', podId: null };
  }
  return { routeClass: rule.routeClass, podId };
};
