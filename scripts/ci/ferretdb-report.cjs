// Preserve full Jest error text; categories are search hints, not root-cause verdicts.
const fs = require('node:fs');
console.log('# FerretDB 2.7.0 bridge evidence');
console.log(`Integration: ${process.env.INTEGRATION_OUTCOME || 'not run'}; HTTP smoke: ${process.env.SMOKE_OUTCOME || 'not run'}`);
console.log(`Run: ${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`);
if (!fs.existsSync('evidence/jest.json')) {
  console.log('No Jest JSON produced. Inspect setup and service logs; this is not a compatibility verdict.');
} else {
  const data = JSON.parse(fs.readFileSync('evidence/jest.json', 'utf8'));
  console.log(`Tests: ${data.numPassedTests} passed, ${data.numFailedTests} failed, ${data.numPendingTests} pending.`);
  let failures = '';
  for (const suite of data.testResults || []) {
    if (suite.status !== 'failed') continue;
    const text = `${suite.name}\n${suite.message || ''}\n${suite.assertionResults.filter(t => t.status === 'failed').map(t => `${t.fullName}\n${t.failureMessages.join('\n')}`).join('\n')}`;
    failures += `${text}\n\n`;
    console.log(`\n## ${suite.name.replace(process.cwd(), '.')}`);
    console.log('```text\n' + text.slice(0, 5000).replaceAll('```', "'''") + '\n```');
  }
  fs.writeFileSync('evidence/failures.txt', failures);
}
console.log('\nFull test names, error lines, backend and database logs are in the ferretdb-evidence artifact. Classify aggregation, transactions, change streams, indexes, TTL and populate only where the error supports it; unexercised operations remain unknown.');
