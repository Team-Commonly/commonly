const fs = require('fs');
const path = require('path');
const ts = require('typescript');

jest.mock('../../../models/Post', () => ({ findById: jest.fn() }));
jest.mock('../../../models/pg/Message', () => ({ findById: jest.fn() }));
jest.mock('../../../models/AgentAsk', () => ({ findOne: jest.fn() }));

const { runtimeOutsiderGrantRouteKeys, classifyRuntimeOutsiderGrantRoute } =
  require('../../../services/runtimeOutsiderGrantRoutes');

const routesDir = path.resolve(__dirname, '../../../routes');
const fileBases = {
  agentsRuntime: '/api/agents/runtime',
  agentHooks: '/api/agents/runtime',
  spawnCredentials: '/api/agents/runtime/spawn-credentials',
  agentEnsemble: '/api/pods',
  messages: '/api/messages',
  artifacts: '/api/artifacts',
  uploads: '/api/uploads',
  github: '/api/github',
  tasksApi: '/api/v1/tasks',
  grants: '/api/grants',
  mcpGrants: '/api/mcp/grants',
};
const wrappers = {
  agentsRuntime: ['agentRuntimeAuth', 'dualAuth'],
  agentHooks: ['agentRuntimeAuth'], spawnCredentials: ['agentRuntimeAuth'],
  agentEnsemble: ['agentRuntimeAuth'], messages: ['dualAuth'],
  artifacts: ['dualAuth'], uploads: ['maybeAgentRuntimeAuth'],
  github: ['anyAuth'], tasksApi: ['auth'],
  grants: ['agentRuntimeAuth', 'dualAuth'], mcpGrants: ['agentRuntimeAuth'],
};

test('every runtime-token acceptor is in the route table', () => {
  const actual = [];
  const unknownAcceptors = [];
  // Discover source files by the middleware they USE, not by a token-prefix
  // grep. That was the route-census miss behind TASK-213 (Vera 79682).
  for (const file of fs.readdirSync(routesDir).filter((entry) => entry.endsWith('.ts'))) {
    const name = path.basename(file, '.ts');
    if (fileBases[name]) continue;
    const source = fs.readFileSync(path.join(routesDir, file), 'utf8');
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const walk = (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && node.expression.expression.getText(tree) === 'router'
          && ['get', 'post', 'put', 'patch', 'delete'].includes(node.expression.name.text)
          && node.arguments.slice(1).some((arg) => ts.isIdentifier(arg) && arg.text === 'agentRuntimeAuth')) {
        unknownAcceptors.push(file);
      }
      ts.forEachChild(node, walk);
    };
    walk(tree);
  }
  expect(unknownAcceptors).toEqual([]);
  for (const [name, base] of Object.entries(fileBases)) {
    const source = fs.readFileSync(path.join(routesDir, `${name}.ts`), 'utf8');
    const tree = ts.createSourceFile(`${name}.ts`, source, ts.ScriptTarget.Latest, true);
    const walk = (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && node.expression.expression.getText(tree) === 'router'
          && ['get', 'post', 'put', 'patch', 'delete'].includes(node.expression.name.text)
          && ts.isStringLiteral(node.arguments[0])) {
        const middleware = node.arguments.slice(1).filter(ts.isIdentifier).map((arg) => arg.text);
        if (middleware.some((entry) => wrappers[name].includes(entry))) {
          actual.push(`${base} ${node.expression.name.text.toUpperCase()} ${node.arguments[0].text}`);
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(tree);
  }
  expect([...new Set(actual)].sort()).toEqual([...runtimeOutsiderGrantRouteKeys].sort());
});

test('private memory passes, shared memory is outward', async () => {
  const req = {
    baseUrl: '/api/agents/runtime', method: 'PUT', route: { path: '/memory' },
    body: { sections: { long_term: { visibility: 'private', content: 'x' } } },
  };
  expect((await classifyRuntimeOutsiderGrantRoute(req)).routeClass).toBe('read');
  req.body.sections.long_term.visibility = 'public';
  expect((await classifyRuntimeOutsiderGrantRoute(req)).routeClass).toBe('outward');
});

test('unscoped posts resolve no pod and broker calls retain their own gate', async () => {
  const classify = (baseUrl, method, routePath, body = {}) =>
    classifyRuntimeOutsiderGrantRoute({ baseUrl, method, route: { path: routePath }, body, params: {} });
  expect((await classify('/api/agents/runtime', 'POST', '/posts')).routeClass).toBe('pod_write');
  expect((await classify('/api/agents/runtime', 'POST', '/posts')).podId).toBeNull();
  expect((await classify('/api/github', 'POST', '/issues')).routeClass).toBe('outward');
  expect((await classify('/api/grants', 'POST', '/:grantId/attenuate')).routeClass).toBe('grant');
  expect((await classify('/api/mcp/grants', 'POST', '/:grantId')).routeClass).toBe('grant');
  expect((await classify('/api/agents/runtime/spawn-credentials', 'POST', '/')).routeClass).toBe('read');
});
