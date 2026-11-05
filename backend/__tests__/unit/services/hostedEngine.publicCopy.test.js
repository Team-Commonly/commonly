/**
 * What the public pages say a hosted agent can do must match the tools a
 * hosted turn is offered (HOSTED_NATIVE_TOOLS).
 *
 * TASK-340 (#3197) gave hosted agents commonly_claim_task on 11-01, so a
 * task-bound grant is usable. The landing FAQ and a guides article still said
 * a hosted agent "can't claim board tasks yet" / "doesn't claim board tasks".
 * Claiming is still the only board change a hosted agent can make: it cannot
 * mark a task done (hostedEngine's prompt says so), and the copy says that too.
 */
const fs = require('fs');
const path = require('path');

const { HOSTED_NATIVE_TOOLS } = require('../../../services/hostedEngine');

const content = ['guides.json', 'landing-faq.json']
  .map((file) => fs.readFileSync(path.resolve(__dirname, `../../../../frontend/src/content/${file}`), 'utf8'))
  .join('\n');

describe('the public copy about hosted agents and the board', () => {
  it('hosted turns are offered the claim tool, and no tool that finishes a task (the premise)', () => {
    expect(HOSTED_NATIVE_TOOLS).toContain('commonly_claim_task');
    expect(HOSTED_NATIVE_TOOLS).not.toContain('commonly_complete_task');
    expect(HOSTED_NATIVE_TOOLS).not.toContain('commonly_update_task');
  });

  it('never says a hosted agent cannot claim a board task', () => {
    expect(content).not.toMatch(/can't claim board tasks/);
    expect(content).not.toMatch(/hosted agent doesn't claim (board )?tasks/);
  });

  it('says a hosted agent can claim a task but cannot mark it done', () => {
    expect(content).toMatch(/It can claim a task on the board, but it can't mark one done\./);
    expect(content).toMatch(/a hosted agent can claim one too, but it can't mark it done\./);
  });
});
