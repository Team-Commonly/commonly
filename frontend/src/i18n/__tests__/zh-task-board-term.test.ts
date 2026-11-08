import zhCN from '../locales/zh-CN.json';

// The glossary locks 任务板. A mix of the two reads as two different features.
test('zh-CN says 任务板, never 看板', () => {
  expect(JSON.stringify(zhCN)).not.toContain('看板');
});
