/**
 * ADR-034 D4: no new Mongo model. Every collection added from now on is a
 * Postgres table (a numbered file in config/migrations plus a repository; see
 * docs/database/schema-migrations.md). This list is the Mongo models that
 * existed when the rule was set, and it only shrinks: a model that moves to
 * Postgres comes off it in the same PR.
 */
const fs = require('fs');
const path = require('path');

const BACKEND_DIR = path.join(__dirname, '../../..');
const MODELS_DIR = path.join(BACKEND_DIR, 'models');

// Files in models/ that register no Mongo model: a Postgres-backed model and a helper.
const NOT_MONGO_MODELS = ['ToolCall.ts', 'integrationPublicConfig.ts'];

const MONGO_MODELS = [
  'AccountDeletion', 'Activity', 'AdminUserMutationLock', 'AgentAsk', 'AgentComputerTakeover',
  'AgentCredential', 'AgentDigestState', 'AgentEnsembleState', 'AgentEvent', 'AgentFirstContact',
  'AgentInstallation', 'AgentMemory', 'AgentPodReadCursor', 'AgentProfile', 'AgentProviderKey',
  'AgentRegistry', 'AgentRun', 'AgentRuntimeObservation', 'AgentTaskRowWakeState', 'AgentTaskWakeState',
  'AgentTemplate', 'Announcement', 'App', 'AppInstallation', 'ApprovalAction',
  'AttentionItem', 'AttributionVisit', 'AuditLog', 'BillingEvent', 'ChannelVerdict',
  'ConnectorSecret', 'DecisionRequest', 'DeviceAuthorization', 'DiscordIntegration', 'DiscordSummaryHistory',
  'ExternalLink', 'File', 'Gateway', 'GithubGigBinding', 'GithubGigDelivery',
  'HookLedgerEvent', 'HostedMcpDcrRegistration', 'Installable', 'InstallableInstallation', 'Integration',
  'InvitationCode', 'Machine', 'MediaObject', 'Message', 'NeedsYouEmail',
  'NeedsYouEmailQuota', 'OAuthLoginState', 'OAuthState', 'OnboardingSilenceEpisode', 'Pod',
  'PodAsset', 'PodInvite', 'PodLink', 'PodMemberFirstMessage', 'Post',
  'RoomGrant', 'SchedulerHeartbeatLease', 'SkillRating', 'StalledConnectEpisode', 'Summary',
  'SystemSetting', 'Task', 'User', 'WaitlistRequest', 'WebhookDelivery',
];

// `mongoose.model('Name', …)` and `model<IName>(\n  'Name', …)` alike.
const REGISTRATION = /(?:mongoose\.)?model\s*(?:<[^>]*>)?\(\s*['"](\w+)['"]/g;

const isSource = (file) => /\.(ts|js)$/.test(file) && !file.endsWith('.d.ts');
const modelFiles = () => fs.readdirSync(MODELS_DIR).filter(isSource);
const namesIn = (file) => [...fs.readFileSync(path.join(MODELS_DIR, file), 'utf8').matchAll(REGISTRATION)]
  .map(([, name]) => name);

const registeredNames = () => new Set(modelFiles().flatMap(namesIn));

// Production source outside the top level of models/, where a model must not be defined.
const SKIP_DIRS = new Set(['node_modules', '__tests__', 'scripts', 'dist', 'coverage']);
const sourceOutsideModels = (dir = BACKEND_DIR) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : sourceOutsideModels(full);
    if (dir === MODELS_DIR || !isSource(entry.name)) return [];
    return [full];
  });

describe('Mongo model freeze (ADR-034 D4)', () => {
  const registered = registeredNames();

  it('registers no Mongo model outside the frozen list', () => {
    const added = [...registered].filter((name) => !MONGO_MODELS.includes(name)).sort();
    // A new collection is a Postgres table: add backend/config/migrations/NNNN_<name>.sql
    // and a repository under backend/repositories/ (docs/adr/ADR-034-postgres-single-store.md).
    expect(added).toEqual([]);
  });

  it('reads a registration from every model file, so a new form cannot slip past', () => {
    const unread = modelFiles()
      .filter((file) => !NOT_MONGO_MODELS.includes(file) && namesIn(file).length === 0);
    // Register with mongoose.model('Name', schema), or move the file out of models/.
    expect(unread).toEqual([]);
  });

  it('defines no Mongo model or schema outside models/', () => {
    const defining = sourceOutsideModels()
      .filter((file) => /mongoose\.model\(|new (mongoose\.)?Schema\(/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(BACKEND_DIR, file));
    expect(defining).toEqual([]);
  });

  it('lists only models that still exist, so the list shrinks as models move', () => {
    const gone = MONGO_MODELS.filter((name) => !registered.has(name));
    // A model that moved to Postgres comes off MONGO_MODELS in the same PR.
    expect(gone).toEqual([]);
  });
});
