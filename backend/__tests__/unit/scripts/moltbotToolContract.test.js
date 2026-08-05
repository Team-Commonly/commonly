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
  readGitlinkSha,
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

      /**
       * A SHALLOW checkout answers this question confidently and wrongly.
       *
       * Both commits are valid objects, so git does not error — it walks back
       * from the tip, hits the shallow graft, treats it as parentless, never
       * reaches the pin, and returns status 1: "not an ancestor". Status 1 is
       * precisely what this function treats as a finding, so the degradation
       * built for git FAILURES does not catch a git ANSWER that is an artifact
       * of missing history.
       *
       * actions/checkout defaults to fetch-depth 1 and passes --depth=1 down to
       * submodules, so the DEFAULT CI checkout is the shallow case. Unguarded,
       * this would red every pin that is not exactly the branch tip — the
       * normal resting state of a submodule pin. Found by @sprint-review.
       *
       * The fix is to fetch more history rather than to give up, because the
       * ambiguity is one-sided (see the exit-0 test below). Measured on the
       * real post-merge state in CI shape — pin one hop back, reached only as
       * a merge commit's second parent, so the fast path misses:
       *
       *   depth-1            is-ancestor → 1  (wrong)    .git 35M
       *   after --deepen=64  is-ancestor → 0  (correct)  .git 36M
       */
      const shallowRepoWhere = ({ ancestry, tip = 'a-different-sha' }) => {
        const calls = [];
        let fetched = 0;
        const exec = jest.fn((_bin, args) => {
          calls.push(args);
          if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') {
            // Real git keeps reporting `true` after a successful --deepen; only
            // --unshallow clears it. Modelled exactly, because a probe that
            // flipped to false would hide a bug in the ladder's exit condition.
            return calls.some((c) => c.includes('--unshallow')) ? 'false\n' : 'true\n';
          }
          if (args[0] === 'rev-parse' && args[1] === '--verify') return '';
          if (args[0] === 'rev-parse') return `${tip}\n`;
          if (args[0] === 'fetch') { fetched += 1; return ''; }
          if (args[0] === 'merge-base') {
            const status = ancestry(fetched);
            if (status !== 0) throw gitError(status);
            return '';
          }
          return '';
        });
        // Pick the rung out by shape, not by position — an argv index would
        // silently read `--quiet` and make every ladder assertion vacuous.
        const rungs = () => calls
          .filter((c) => c[0] === 'fetch')
          .map((c) => c.find((a) => /^--(deepen=\d+|unshallow)$/.test(a)));
        return { exec, calls, rungs };
      };

      it('climbs the deepen ladder and reports contained once history reaches the pin', () => {
        // Status 1 while shallow, 0 after one deepen — the measured shape above.
        const { exec, rungs } = shallowRepoWhere({ ancestry: (fetched) => (fetched >= 1 ? 0 : 1) });
        const result = checkPinReachable({ exec });
        expect(result.state).toBe('contained');
        // It must stop at the rung that answered, not walk to --unshallow.
        expect(rungs()).toEqual(['--deepen=64']);
      });

      /**
       * Why the ladder is cheap enough to run on every CI job: a FOUND path
       * cannot be a graft artifact. Grafts remove history; they never invent
       * it. So exit 0 is trustworthy even in a shallow repo and terminates
       * immediately — the common case never fetches anything.
       */
      it('treats exit 0 as terminal even while shallow, without deepening', () => {
        const { exec, rungs } = shallowRepoWhere({ ancestry: () => 0 });
        expect(checkPinReachable({ exec }).state).toBe('contained');
        expect(rungs()).toEqual([]);
      });

      /**
       * The reason the shallow probe is an ENTRY CONDITION and never a verdict.
       *
       * A previous version returned `undetermined` here and told the caller to
       * set `fetch-depth: 0`. That reds at rest — the moment openclaw main
       * moves past the pin, which is its normal state, every commonly PR gets
       * exit 2 because a different repo advanced. It also makes any ladder
       * below it dead code that reviews clean, because the check keeps
       * "passing" while permanently losing the ability to say `contained`.
       * Caught by @ux-lead.
       */
      it('does not stop at the shallow probe', () => {
        const { exec } = shallowRepoWhere({ ancestry: (fetched) => (fetched >= 1 ? 0 : 1) });
        const result = checkPinReachable({ exec });
        expect(result.state).not.toBe('undetermined');
        expect(result.detail).not.toMatch(/fetch-depth/);
      });

      it('climbs in widening rungs and reports orphaned only after a full fetch', () => {
        const { exec, rungs } = shallowRepoWhere({ ancestry: () => 1 }); // never reachable
        const result = checkPinReachable({ exec });
        expect(result.state).toBe('orphaned');
        expect(rungs()).toEqual(['--deepen=64', '--deepen=256', '--unshallow']);
        // Non-vacuity: the verdict has to say it exhausted the history, or it
        // is indistinguishable from the shallow false positive it replaced.
        expect(result.detail).toMatch(/full history/);
      });

      /**
       * `--unshallow` brings every object reachable from the branch. After it,
       * "the pin object does not exist" (128) stops being an error and becomes
       * the same finding as "not an ancestor" — nothing on that branch reaches
       * it. Before it, the identical status means only that we have not fetched
       * far enough, which is why the two are not folded together.
       */
      it('reports orphaned when the pin is still absent after a full fetch', () => {
        const { exec } = shallowRepoWhere({ ancestry: () => 128 });
        const result = checkPinReachable({ exec });
        expect(result.state).toBe('orphaned');
        expect(result.detail).toMatch(/absent even after a full fetch/);
      });

      it('names origin and the branch on every rung, never a bare fetch', () => {
        const { exec, calls } = shallowRepoWhere({ ancestry: () => 1 });
        checkPinReachable({ exec });
        const fetches = calls.filter((c) => c[0] === 'fetch');
        expect(fetches.length).toBeGreaterThan(0);
        // A submodule populated by `submodule update --depth=1` is left with a
        // narrow refspec that a bare `git fetch` will honour, quietly fetching
        // nothing while appearing to succeed.
        fetches.forEach((c) => {
          expect(c.slice(-2)).toEqual(['origin', readDeclaredBranch()]);
        });
      });

      it('degrades to undetermined when a deepen rung fails', () => {
        const exec = jest.fn((_bin, args) => {
          if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') return 'true\n';
          if (args[0] === 'rev-parse' && args[1] === '--verify') return '';
          if (args[0] === 'rev-parse') return 'a-different-sha\n';
          if (args[0] === 'merge-base') throw gitError(1);
          if (args[0] === 'fetch') throw gitError(128); // network down mid-climb
          return '';
        });
        const result = checkPinReachable({ exec });
        expect(result.state).toBe('undetermined');
        expect(result.detail).toMatch(/deepen/);
      });

      /**
       * The fast path, and the only answer available with no history at all:
       * if the pin IS the tip, containment is settled. This is also the common
       * case immediately after a bump.
       */
      it('reports contained without ancestry when the pin is the branch tip', () => {
        const pin = readGitlinkSha({ full: true });
        const { exec, calls } = shallowRepoWhere({
          ancestry: () => { throw new Error('ancestry must not be consulted here'); },
          tip: pin,
        });
        const result = checkPinReachable({ exec });
        expect(result.state).toBe('contained');
        expect(result.detail).toMatch(/tip/);
        // Shallowness is irrelevant on this path — assert we never got that far.
        expect(calls.some((c) => c[0] === 'merge-base')).toBe(false);
      });

      it('reports orphaned when --is-ancestor exits 1 on a full clone', () => {
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
       * worth less than no check. On a repo we never deepened there is no
       * evidence the object was ever meant to be here, so it degrades to
       * undetermined, which is still non-zero.
       */
      it('reports undetermined, not orphaned, when git errors above 1 on a full clone', () => {
        const exec = jest.fn((_bin, args) => {
          if (args[0] === 'merge-base') throw gitError(128);
          return '';
        });
        const result = checkPinReachable({ exec });
        expect(result.state).toBe('undetermined');
        expect(result.detail).toMatch(/submodule update --init/);
      });

      /**
       * `git submodule update --depth=1` leaves NO `refs/remotes/origin/*` —
       * only the pin — so the fetch fallback is the default CI path, and its
       * depth is the whole cost of the check.
       *
       * A plain `git fetch origin <branch>` into a shallow repo does not stay
       * shallow for the ref it fetches; it brings the branch's entire history.
       * Measured on the real fixture, same verdict both ways:
       *
       *   plain fetch      .git 35M → 314M, 11.4s, ladder never ran
       *   --depth=1 fetch  .git 35M →  71M,  1.3s, ladder ran one rung
       *
       * That is the `fetch-depth: 0` cost this ladder exists to avoid, paid
       * silently. It is invisible to a mocked exec — both shapes call `fetch`
       * and both hand back a usable ref — so this test pins the flag itself.
       */
      it('caps the first fetch at depth 1 when the repo is shallow', () => {
        const { exec, calls } = shallowRepoWhere({ ancestry: (fetched) => (fetched >= 2 ? 0 : 1) });
        exec.mockImplementationOnce(() => { throw gitError(1); }); // no origin/<branch> ref
        checkPinReachable({ exec });
        const first = calls.find((c) => c[0] === 'fetch');
        expect(first).toContain('--depth=1');
      });

      it('does not cap the first fetch on a full clone, where history is already there', () => {
        const calls = [];
        const exec = jest.fn((_bin, args) => {
          calls.push(args);
          if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') return 'false\n';
          if (args[0] === 'rev-parse' && args[1] === '--verify') throw gitError(1);
          if (args[0] === 'rev-parse') return 'a-different-sha\n';
          return '';
        });
        checkPinReachable({ exec });
        const first = calls.find((c) => c[0] === 'fetch');
        expect(first).not.toContain('--depth=1');
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
