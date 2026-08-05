/**
 * Guards scripts/verify-moltbot-tool-contract.js — the check that fires when a
 * submodule bump swaps the openclaw lineage and drops a tool the heartbeat
 * trailer tells every moltbot to call.
 *
 * The script itself is the artifact that survives the next bump; this suite is
 * what keeps the script honest. Both halves matter, and the second is the one
 * that was missing every previous time: the pin regressed on 2026-05-17 and
 * again on 2026-05-24 (after #418 had already fixed it by hand), and nothing
 * anywhere could tell.
 *
 * Fixtures are the two REAL lineages, reduced to their tool declarations, so a
 * parser change is measured against the shapes that actually shipped rather
 * than against invented ones.
 */

const {
  parseDeclaredTools,
  collectRequiredTools,
  loadCyclesTrailer,
  readDeclaredBranch,
  checkPinReachable,
} = require('../../../../scripts/verify-moltbot-tool-contract');

// Shape lifted verbatim from extensions/commonly/src/tools.ts at both refs.
const declaration = (name) => `
    {
      name: "${name}",
      description: "…",
      handler: async () => jsonResult({ ok: true }),
    },`;

// pin 0082147920 (openclaw main) — has react_to_message, lacks log_cycle
const PIN_SOURCE = [
  'commonly_post_message', 'commonly_get_messages', 'commonly_attach_file',
  'commonly_react_to_message', 'commonly_read_agent_memory',
].map(declaration).join('\n');

// rebase-2026.3.29 — has log_cycle + open_dm, lacks react_to_message
const BRANCH_SOURCE = [
  'commonly_post_message', 'commonly_get_messages', 'commonly_attach_file',
  'commonly_log_cycle', 'commonly_open_dm', 'commonly_save_my_memory',
].map(declaration).join('\n');

describe('moltbot tool contract', () => {
  describe('required tools are derived from the trailer, not restated', () => {
    it('reads the live trailer and extracts the tool it instructs agents to call', () => {
      const trailer = loadCyclesTrailer();

      // Control: a failed extraction returns '' and would make every
      // assertion below pass by emptiness — the exact shape that let four
      // wrong claims about this survive.
      expect(trailer.length).toBeGreaterThan(200);
      expect(trailer).toContain('Memory cycle reflection');

      const required = collectRequiredTools();
      expect([...required.keys()]).toContain('commonly_log_cycle');
      expect(required.size).toBeGreaterThan(0);
    });

    it('attributes each required tool to the source that demands it', () => {
      const required = collectRequiredTools();
      expect(required.get('commonly_log_cycle')).toMatch(/trailer/i);
    });
  });

  describe('declared tools are parsed from declarations, not mentions', () => {
    it('finds every tool the pin lineage declares', () => {
      const declared = parseDeclaredTools(PIN_SOURCE);
      expect(declared.has('commonly_react_to_message')).toBe(true);
      expect(declared.has('commonly_log_cycle')).toBe(false);
      expect(declared.size).toBe(5);
    });

    it('finds every tool the branch lineage declares', () => {
      const declared = parseDeclaredTools(BRANCH_SOURCE);
      expect(declared.has('commonly_log_cycle')).toBe(true);
      expect(declared.has('commonly_react_to_message')).toBe(false);
      expect(declared.size).toBe(6);
    });

    // The whole investigation turned on this distinction. `presets.ts` asserted
    // a tool existed in another repo; the tool's NAME appeared in prose in
    // several places while no runtime declared it. A parser that accepts a
    // mention reproduces the original defect inside the guard against it.
    it('does not count a name that only appears in prose', () => {
      const proseOnly = `
        {
          name: "commonly_post_message",
          description: "Post a message. Unlike commonly_log_cycle, this is not append-only.",
        },`;
      const declared = parseDeclaredTools(proseOnly);
      expect(declared.has('commonly_post_message')).toBe(true);
      expect(declared.has('commonly_log_cycle')).toBe(false);
    });

    it('accepts single or double quotes, since the two lineages differ', () => {
      expect(parseDeclaredTools("name: 'commonly_log_cycle',").has('commonly_log_cycle')).toBe(true);
      expect(parseDeclaredTools('name: "commonly_log_cycle",').has('commonly_log_cycle')).toBe(true);
    });
  });

  describe('the contract discriminates between the two lineages', () => {
    const missingFrom = (source) => {
      const declared = parseDeclaredTools(source);
      return [...collectRequiredTools().keys()].filter((t) => !declared.has(t));
    };

    it('FAILS against the pin — this is the live regression', () => {
      expect(missingFrom(PIN_SOURCE)).toEqual(['commonly_log_cycle']);
    });

    it('PASSES against the branch', () => {
      expect(missingFrom(BRANCH_SOURCE)).toEqual([]);
    });

    // Verified against the real files on 2026-08-04: the pin declares 25
    // commonly_* tools and is missing commonly_log_cycle; the branch declares
    // 29 and is missing nothing the trailer names. If those numbers move, the
    // pin moved — which is the event this whole check exists to catch.
    it('is not vacuous: the two lineages give different verdicts', () => {
      expect(missingFrom(PIN_SOURCE)).not.toEqual(missingFrom(BRANCH_SOURCE));
    });
  });

  /**
   * Pin reachability — a second invariant on the same subject.
   *
   * The tool contract asks what the pin DECLARES. This asks whether the pin is
   * REACHABLE from the branch `.gitmodules` claims to track. Neither implies
   * the other, and #840 is the proof: it pinned a commit with an exactly
   * correct tool set that lived only on an unmerged feature branch, so the
   * tool contract went green over a pin a squash-merge would have orphaned.
   */
  describe('pin reachability', () => {
    describe('readDeclaredBranch', () => {
      // The real .gitmodules declares TWO submodules and only the second has a
      // `branch =`. A first-match regex therefore returns the right answer for
      // the wrong reason, and would start lying the day the other submodule
      // gains a branch. The fixture gives BOTH a branch so the test can tell
      // block-scoped parsing apart from luck.
      const TWO_SUBMODULES = [
        '[submodule "external/awesome-openclaw-skills"]',
        '\tpath = external/awesome-openclaw-skills',
        '\turl = https://github.com/VoltAgent/awesome-openclaw-skills',
        '\tbranch = some-other-branch',
        '[submodule "_external/clawdbot"]',
        '\tpath = _external/clawdbot',
        '\turl = https://github.com/Team-Commonly/openclaw',
        '\tbranch = rebase-2026.3.29',
      ].join('\n');

      it('reads the clawdbot block, not the first branch in the file', () => {
        expect(readDeclaredBranch(TWO_SUBMODULES)).toBe('rebase-2026.3.29');
      });

      it('returns null when the clawdbot block declares no branch', () => {
        const noBranch = TWO_SUBMODULES.replace('\tbranch = rebase-2026.3.29', '');
        expect(readDeclaredBranch(noBranch)).toBeNull();
      });

      it('returns null when there is no clawdbot block at all', () => {
        expect(readDeclaredBranch('[submodule "other"]\n\tbranch = main\n')).toBeNull();
      });
    });

    describe('checkPinReachable', () => {
      // `git merge-base --is-ancestor` communicates its ANSWER through the exit
      // code: 1 means "not an ancestor". Anything above 1 is git failing, which
      // is a different thing entirely.
      const gitError = (status) => Object.assign(new Error(`git exited ${status}`), { status });

      it('reports contained when the ancestry check succeeds', () => {
        const exec = jest.fn(() => '');
        expect(checkPinReachable({ exec }).state).toBe('contained');
      });

      it('reports orphaned when --is-ancestor exits 1', () => {
        const exec = jest.fn((_bin, args) => {
          if (args[0] === 'merge-base') throw gitError(1);
          return '';
        });
        expect(checkPinReachable({ exec }).state).toBe('orphaned');
      });

      /**
       * The control that matters. A git failure — bad object, corrupt repo,
       * permissions — must NOT be reported as "the pin is orphaned", because a
       * false violation gets the check disabled, and a check that cried wolf is
       * worth less than no check. It must degrade to undetermined, which is
       * still non-zero.
       */
      it('reports undetermined, not orphaned, when git errors above 1', () => {
        const exec = jest.fn((_bin, args) => {
          if (args[0] === 'merge-base') throw gitError(128);
          return '';
        });
        expect(checkPinReachable({ exec }).state).toBe('undetermined');
      });

      it('falls back to fetching when the remote ref is not present locally', () => {
        const calls = [];
        const exec = jest.fn((_bin, args) => {
          calls.push(args[0]);
          if (args[0] === 'rev-parse') throw gitError(1);
          return '';
        });
        expect(checkPinReachable({ exec }).state).toBe('contained');
        expect(calls).toContain('fetch');
      });

      it('reports undetermined when the branch can neither be resolved nor fetched', () => {
        const exec = jest.fn((_bin, args) => {
          if (args[0] === 'rev-parse' || args[0] === 'fetch') throw gitError(128);
          return '';
        });
        const result = checkPinReachable({ exec });
        expect(result.state).toBe('undetermined');
        // Non-vacuity: an undetermined verdict has to say what stopped it, or
        // it is indistinguishable from the check silently not running.
        expect(result.detail).toMatch(/fetch/i);
      });
    });
  });
});
