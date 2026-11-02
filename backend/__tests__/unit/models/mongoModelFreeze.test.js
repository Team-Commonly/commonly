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

// Every model call, whatever its receiver or generics: `mongoose.model(`,
// `connection.model(`, `model<IName>(\n  …`. Each must name its model with a
// string literal, or the test cannot know what it registers.
const MODEL_CALL = /\bmodel\s*(?:<[^>]*>)?\(/g;
// The whole first argument must be the literal: `'User' + suffix` is not `User`.
const LITERAL_NAME = /^\s*(['"`])(\w+)\1\s*[,)]/;
// Outside models/ any of these is a model defined where the freeze cannot read
// it. No space before `(`, so prose like "the model (fallback)" never matches.
const DEFINITION = /\bmodel(?:<[^>]*>)?\(|new\s+(?:mongoose\.)?Schema\s*(?:<[^>]*>)?\(/;

// One entry per model call: the name it registers, or null when it is not a literal.
const registrationsIn = (source) => [...source.matchAll(MODEL_CALL)].map((call) => {
  const name = LITERAL_NAME.exec(source.slice(call.index + call[0].length));
  return name ? name[2] : null;
});

const isSource = (file) => /\.(ts|js)$/.test(file) && !file.endsWith('.d.ts');
const modelFiles = () => fs.readdirSync(MODELS_DIR).filter(isSource)
  .map((file) => ({ file, registrations: registrationsIn(fs.readFileSync(path.join(MODELS_DIR, file), 'utf8')) }));

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
  const files = modelFiles();
  const registered = new Set(files.flatMap(({ registrations }) => registrations).filter(Boolean));

  it('reads every registration form it is meant to catch (positive controls)', () => {
    expect(registrationsIn("mongoose.model('A', s)")).toEqual(['A']);
    expect(registrationsIn('mongoose.model<IB, BModel>(\n  "B",\n  s)')).toEqual(['B']);
    expect(registrationsIn('mongoose.model(`C`, s)')).toEqual(['C']);
    expect(registrationsIn("conn.model('D', s)")).toEqual(['D']);
    expect(registrationsIn("(mongoose.models.E as Model<IE>) || model<IE>('E', s)")).toEqual(['E']);
    expect(registrationsIn('mongoose.model(NAME, s)')).toEqual([null]);
    expect(registrationsIn("mongoose.model('User' + suffix, s)")).toEqual([null]);
    // eslint-disable-next-line no-template-curly-in-string -- the fixture is source text
    expect(registrationsIn('mongoose.model(`User${suffix}`, s)')).toEqual([null]);
    expect(registrationsIn("mongoose.model('G')")).toEqual(['G']);
    ['mongoose.model(NAME, s)', 'model<IF>(`F`, s)', 'new Schema<IG>({})', 'new mongoose.Schema({})']
      .forEach((source) => expect(DEFINITION.test(source)).toBe(true));
    expect(DEFINITION.test('// fall back to the default model (no override).')).toBe(false);
  });

  it('registers no Mongo model outside the frozen list', () => {
    const added = [...registered].filter((name) => !MONGO_MODELS.includes(name)).sort();
    // A new collection is a Postgres table: add backend/config/migrations/NNNN_<name>.sql
    // and a repository under backend/repositories/ (docs/adr/ADR-034-postgres-single-store.md).
    expect(added).toEqual([]);
  });

  it('can read the name of every registration, so a new form cannot slip past', () => {
    const unread = files
      .filter(({ file, registrations }) => (NOT_MONGO_MODELS.includes(file)
        ? registrations.length > 0
        : registrations.length === 0 || registrations.includes(null)))
      .map(({ file }) => file);
    // Register with mongoose.model('Name', schema): a literal name.
    expect(unread).toEqual([]);
  });

  it('defines no Mongo model or schema outside models/', () => {
    const defining = sourceOutsideModels()
      .filter((file) => DEFINITION.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(BACKEND_DIR, file));
    expect(defining).toEqual([]);
  });

  it('lists only models that still exist, so the list shrinks as models move', () => {
    const gone = MONGO_MODELS.filter((name) => !registered.has(name));
    // A model that moved to Postgres comes off MONGO_MODELS in the same PR.
    expect(gone).toEqual([]);
  });
});
