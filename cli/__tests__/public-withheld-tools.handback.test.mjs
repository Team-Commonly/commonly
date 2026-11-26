/**
 * ADR-037 Phase 1 (F654): public seats are not offered the hand-back tools.
 * A public seat answers strangers, and commonly_send_plan puts a decision card
 * in front of a named person, so a public agent starts without them. A seat
 * that is not public is offered them as usual.
 */
import {
  PUBLIC_ONLY_WITHHELD_TOOLS, PUBLIC_SEAT_WITHHELD_TOOLS, PUBLIC_WITHHELD_TOOLS, publicSeatWithheldTools,
} from '../src/lib/public-withheld-tools.js';
import { PUBLIC_GOOSE_TOOLS } from '../src/lib/adapters/goose.js';
import { buildQwenMcpConfig, publicExcludedTools } from '../src/lib/adapters/qwen.js';

const HAND_BACK_TOOLS = [
  'commonly_send_plan', 'commonly_hand_back', 'commonly_get_hand_back', 'commonly_withdraw_hand_back',
];

const server = { name: 'commonly', transport: 'stdio', command: [process.execPath, '/tmp/commonly-mcp-test.mjs'] };
const qwenEntry = (ctx) => buildQwenMcpConfig([server], {
  credentialFile: '/tmp/cred', instanceUrl: 'https://api.commonly.me', ...ctx,
}).mcpServers.commonly;

describe('hand-back tools on public seats (ADR-037, F654)', () => {
  test('every public seat withholds all four, owner-woken turn or not', () => {
    for (const tool of HAND_BACK_TOOLS) {
      expect(PUBLIC_SEAT_WITHHELD_TOOLS).toContain(tool);
      expect(publicSeatWithheldTools({})).toContain(tool);
      expect(publicSeatWithheldTools({ ownerWoken: true })).toContain(tool);
    }
  });

  test('they are withheld on public trust only: a Claude workspace seat keeps them', () => {
    for (const tool of HAND_BACK_TOOLS) {
      expect(PUBLIC_ONLY_WITHHELD_TOOLS).toContain(tool);
      expect(PUBLIC_WITHHELD_TOOLS).not.toContain(tool);
    }
  });

  test("Goose's public allowlist does not offer them", () => {
    for (const tool of HAND_BACK_TOOLS) expect(PUBLIC_GOOSE_TOOLS).not.toContain(tool);
  });

  test('a public Qwen seat excludes them under both spellings; a normal seat excludes nothing', () => {
    const names = publicExcludedTools(['commonly'], {});
    for (const tool of HAND_BACK_TOOLS) {
      expect(names).toContain(tool);
      expect(names).toContain(`mcp__commonly__${tool}`);
      expect(qwenEntry({ publicSeat: true }).excludeTools).toContain(tool);
    }
    expect(qwenEntry({ publicSeat: false }).excludeTools).toBeUndefined();
  });
});
