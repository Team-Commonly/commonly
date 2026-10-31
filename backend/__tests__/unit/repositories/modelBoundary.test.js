const path = require('path');
const { ESLint } = require('eslint');

const eslint = new ESLint({ cwd: path.resolve(__dirname, '../../..') });
it.each([
  ["import Cursor from '../models/AgentPodReadCursor';", 'no-restricted-imports'],
  ["const Cursor = require('../models/AgentPodReadCursor');", 'no-restricted-modules'],
])('blocks production model access: %s', async (source, rule) => {
  const [service] = await eslint.lintText(source, { filePath: 'services/boundaryProbe.ts' });
  expect(service.messages.map((message) => message.ruleId)).toContain(rule);
  const [repository] = await eslint.lintText(source, { filePath: 'repositories/boundaryProbe.ts' });
  expect(repository.messages.map((message) => message.ruleId)).not.toContain(rule);
});
