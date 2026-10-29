// Module boundaries for the TS side (docs/development/workflow.md). Go boundaries live in entropy.json.
module.exports = {
  forbidden: [
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    { name: 'gen-is-a-leaf', severity: 'error', from: { path: '^gen/' }, to: { pathNot: '^gen/' } },
    { name: 'nothing-imports-e2e', severity: 'error', from: { pathNot: '^e2e/' }, to: { path: '^e2e/' } },
    { name: 'no-test-routes-from-prod', severity: 'error', from: { path: '^worker/src/', pathNot: '^worker/src/test/' }, to: { path: '^worker/src/test/' } }
  ],
  options: { doNotFollow: { path: 'node_modules' }, tsPreCompilationDeps: true }
};
