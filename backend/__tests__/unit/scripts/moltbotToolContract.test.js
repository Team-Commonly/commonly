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

const fs = require('fs');
const path = require('path');

const {
  parseDeclaredTools,
  collectRequiredTools,
  loadCyclesTrailer,
  loadMentionCues,
  readDeclaredBranch,
  checkPinReachable,
  readGitlinkSha,
  stripComments,
  MENTION_CUES,
  parsePresets,
  checkPresetToolNames,
  loadNativeTools,
  readExtensionToolsAtPin,
  NAMED_AS_REMOVED,
  PRESETS_FILE,
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

// rebase-2026.3.29 — has log_cycle + open_dm + read_attachment, lacks
// react_to_message. read_attachment and open_dm are listed because the
// widened contract requires them (the mention cues name both); they are real
// declarations on this lineage, not fixture padding.
const BRANCH_SOURCE = [
  'commonly_post_message', 'commonly_get_messages', 'commonly_attach_file',
  'commonly_log_cycle', 'commonly_open_dm', 'commonly_save_my_memory',
  'commonly_read_attachment',
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
      expect(declared.size).toBe(7);
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

    // Three, not one. The trailer-only contract caught commonly_log_cycle;
    // widening to the mention cues catches two more that the old pin also
    // lacked and every agent was told on every mention to call. Measured
    // against the real 00821479 tool block on 2026-08-05.
    it('FAILS against the pin — this is the live regression', () => {
      expect(missingFrom(PIN_SOURCE)).toEqual([
        'commonly_log_cycle', 'commonly_read_attachment', 'commonly_open_dm',
      ]);
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
   * The mention cues — the wide surface. The trailer reaches an agent once a
   * heartbeat; these reach every agent on every mention. Widening the contract
   * to them is only safe because of the driver-scoped exclusion, and these
   * tests exist mostly to keep that exclusion from becoming a hole.
   */
  describe('inline mention cues', () => {
    const cueText = loadMentionCues();

    it('reads the live cues rather than a restatement of them', () => {
      // Control: an extraction that silently returned '' would satisfy every
      // "does not require X" assertion below by emptiness.
      expect(cueText.length).toBeGreaterThan(1000);
      expect(cueText).toContain('[Pod context:');
      expect(cueText).toContain('[Reply mechanics:');
    });

    it('requires the tools the cues tell every agent to call', () => {
      const required = collectRequiredTools();
      ['commonly_attach_file', 'commonly_read_attachment', 'commonly_post_message',
        'commonly_get_messages', 'commonly_open_dm'].forEach((tool) => {
        expect([...required.keys()]).toContain(tool);
      });
      expect(required.get('commonly_open_dm')).toMatch(/mention cues/i);
    });

    // The reason a naive widening is wrong. These are MCP names, deliberately
    // present beside their openclaw counterpart because the cue ships to every
    // seat. Requiring them of an openclaw pin reds a correct line.
    it('does not require the MCP names the cues address to other drivers', () => {
      const required = [...collectRequiredTools().keys()];
      expect(required).not.toContain('commonly_read_file');
      expect(required).not.toContain('commonly_dm_agent');
    });

    // ...and the exclusion has to stay earned. Both names must still be in the
    // delivered text; an exemption for a tool no longer mentioned is a hole
    // that would silently excuse a future, genuine requirement.
    it('exempts only names that actually appear in the cues', () => {
      expect(cueText).toContain('commonly_read_file');
      expect(cueText).toContain('commonly_dm_agent');
    });

    // Both halves of each pair must be present, or the cue is telling one
    // driver class to call something it does not have — the original defect.
    it('keeps each capability named under BOTH driver namespaces', () => {
      expect(cueText).toContain('commonly_read_attachment');
      expect(cueText).toContain('commonly_open_dm');
    });

    it('ignores tool names that appear only in comments', () => {
      // agentMentionService.ts discusses tools at length in comments,
      // including ones that deliberately do not exist on the pinned lineage.
      // A comment is not delivered to an agent and must not become a
      // requirement.
      const src = [
        '// discussion of `commonly_ghost_tool` that no runtime declares',
        '/* commonly_block_comment_tool */',
        'const formatThingCue = (): string =>',
        '  `[Thing: call commonly_real_tool to do the thing. '
        + 'Padding so the region clears the non-vacuity floor for slicing.]`;',
        '',
        'const next = 1;',
      ].join('\n');
      const stripped = stripComments(src);
      expect(stripped).toContain('commonly_real_tool');
      expect(stripped).not.toContain('commonly_ghost_tool');
      expect(stripped).not.toContain('commonly_block_comment_tool');
      // Blanking, not deleting: line structure survives so `^const` anchors
      // still land where they did in the original.
      expect(stripped.split('\n')).toHaveLength(src.split('\n').length);
    });

    it('does not treat a URL as a line comment', () => {
      expect(stripComments('const u = "https://example.com/commonly_x";'))
        .toContain('commonly_x');
    });

    // The coverage-gap guard. A cue added and not registered would ship tool
    // names nobody checks, and the check would still print OK — which is the
    // failure mode this whole file exists to prevent, reproduced inside it.
    it('every cue the service defines is registered', () => {
      const servicePath = path.join(__dirname, '../../../services/agentMentionService.ts');
      const src = fs.readFileSync(servicePath, 'utf8');
      const defined = (stripComments(src).match(/^const (format[A-Za-z]*(?:Cue|Frame))\b/gm) || [])
        .map((m) => m.replace('const ', ''));
      expect(defined.length).toBeGreaterThan(0);
      expect(defined.sort()).toEqual([...MENTION_CUES].sort());
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
       * it. So exit 0 is trustworthy even in a shallow repo and terminates at
       * once — the climb stops at the first rung that finds a path.
       *
       * This said "the common case never fetches anything" until 2026-08-05,
       * which was wrong: a pin at rest sits BEHIND its branch tip, so the fast
       * path misses and the steady state is one rung, not zero. The test below
       * is still correct — it pins exit-0-is-terminal — but the claim it was
       * filed under was not. Cheap here means "stops early", never "does
       * nothing". Caught by @sprint-review against #840's live CI verdict.
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

  /**
   * The preset↔runtime name check. Its two shape controls (`starts.length < 20`
   * in parsePresets, `names.size < 5` in loadNativeTools) are the load-bearing
   * part: without them a refactor that breaks the slice or the regex makes the
   * whole check vacuous and green. A vacuous checker is worse than no checker,
   * because it is cited as evidence. Both are pinned here, in both directions.
   */
  describe('preset tool names resolve on the runtime the preset declares', () => {
    const presetBlock = (id, runtime, body = '') => [
      `    id: '${id}',`,
      `    runtime: '${runtime}',`,
      body,
    ].filter(Boolean).join('\n');

    // A source with enough blocks to clear the shape control, so a test about
    // anything else is not silently measuring the control instead.
    const manyPresets = (extra = []) => [
      ...Array.from({ length: 22 }, (_, i) => presetBlock(`filler-${i}`, 'openclaw')),
      ...extra,
    ].join('\n');

    describe('parsePresets', () => {
      it('extracts the id, the declared runtime and every tool name per block', () => {
        const presets = parsePresets(manyPresets([
          presetBlock(
            'social-amplifier', 
            'internal',
            '    prompt: `Only post final content via commonly_post_message.`,',
          ),
        ]));
        const amplifier = presets.find((p) => p.id === 'social-amplifier');
        expect(amplifier.runtime).toBe('internal');
        expect(amplifier.names).toEqual(['commonly_post_message']);
      });

      it('sees a tool named in prose, with no call parentheses', () => {
        // This is why the check is not call-position scoped: both `internal`
        // presets on main name their only tool in a sentence, so a
        // call-position check covers zero of the runtime this row is about.
        const [preset] = parsePresets(manyPresets([
          presetBlock(
            'prose-only', 
            'internal',
            '    prompt: `Run tools silently. Post via commonly_post_message only.`,',
          ),
        ])).filter((p) => p.id === 'prose-only');
        expect(preset.names).toContain('commonly_post_message');
      });

      it('refuses to report a result when the block shape no longer matches', () => {
        // Two blocks parse cleanly and mean nothing — the file has 30+. Without
        // this control a broken segmenter reports "0 presets, all names
        // resolved" and exits 0.
        expect(() => parsePresets(presetBlock('only-one', 'openclaw')))
          .toThrow(/parsed 1 preset definitions/);
      });

      it('refuses a block that declares no runtime rather than guessing one', () => {
        expect(() => parsePresets(manyPresets(["    id: 'runtime-less',"])))
          .toThrow(/'runtime-less' declares 0 distinct runtimes/);
      });

      it('refuses a block that declares several runtimes', () => {
        expect(() => parsePresets(manyPresets([[
          "    id: 'two-runtimes',",
          "    runtime: 'openclaw',",
          "    config: { runtime: 'internal' },",
        ].join('\n')]))).toThrow(/declares 2 distinct runtimes/);
      });

      it('parses the live presets.ts without tripping either refusal', () => {
        // Non-vacuity: every negative case above is satisfied by a parser that
        // throws on everything.
        const presets = parsePresets(fs.readFileSync(PRESETS_FILE, 'utf8'));
        expect(presets.length).toBeGreaterThanOrEqual(20);
        expect(presets.every((p) => p.runtime && p.id)).toBe(true);
      });
    });

    describe('loadNativeTools', () => {
      const nativeSource = (names) => `
const TOOLS = [
${names.map((n) => `  { type: 'function', function: { name: '${n}', description: '…' } },`).join('\n')}
];

const toolsForConfig = () => TOOLS;
`;

      it('slices the TOOLS array out of the live service', () => {
        const names = loadNativeTools();
        // Named, not counted: the point of resolving per-runtime is that this
        // surface spells shared capabilities differently from the extension's.
        expect(names.has('commonly_post_message')).toBe(true);
        expect(names.has('commonly_read_memory')).toBe(true);
        expect(names.has('commonly_read_agent_memory')).toBe(false);
      });

      it('refuses to report a result when the parse comes up short', () => {
        // A short parse marks every internal preset's tools missing — loud, and
        // wrong. Distinguish "the array shrank" from "the slice stopped matching".
        expect(() => loadNativeTools({ read: () => nativeSource(['commonly_post_message']) }))
          .toThrow(/parsed 1 tool names/);
      });

      it('refuses when the declaration is gone entirely', () => {
        expect(() => loadNativeTools({ read: () => 'export const TOOL_LIST = [];' }))
          .toThrow(/const TOOLS not found/);
      });

      it('does not count a name that only appears in a comment', () => {
        const withComment = `${nativeSource([
          'commonly_post_message', 'commonly_create_task', 'commonly_read_memory',
          'commonly_write_memory', 'commonly_read_context',
        ])}\n// TODO: add { name: 'commonly_ghost' } here\n`;
        const names = loadNativeTools({ read: () => withComment });
        expect(names.has('commonly_ghost')).toBe(false);
      });
    });

    describe('checkPresetToolNames', () => {
      const sets = {
        openclaw: new Set(['commonly_post_message', 'commonly_create_post']),
        internal: new Set(['commonly_post_message']),
      };
      const mentionsRemoved = NAMED_AS_REMOVED.map(
        (t, i) => presetBlock(`removed-note-${i}`, 'openclaw', `    prompt: \`${t} was removed.\`,`),
      );

      it('flags a name absent on the runtime its preset declares', () => {
        // The row's scenario: create_post exists on openclaw only, and is
        // correct today purely because all its sites sit in openclaw presets.
        const presets = parsePresets(manyPresets([
          ...mentionsRemoved,
          presetBlock('x-curator', 'internal', '    prompt: `Call commonly_create_post(podId).`,'),
        ]));
        const { missing } = checkPresetToolNames({ presets, sets });
        expect(missing).toHaveLength(1);
        expect(missing[0].tool).toBe('commonly_create_post');
        expect(missing[0].preset.id).toBe('x-curator');
        expect(missing[0].preset.runtime).toBe('internal');
        expect(missing[0].preset.line).toBeGreaterThan(0);
      });

      it('passes the same name when its preset declares a runtime that has it', () => {
        const presets = parsePresets(manyPresets([
          ...mentionsRemoved,
          presetBlock('x-curator', 'openclaw', '    prompt: `Call commonly_create_post(podId).`,'),
        ]));
        expect(checkPresetToolNames({ presets, sets }).missing).toHaveLength(0);
      });

      it('reports a runtime it has no tool set for instead of skipping it', () => {
        // Silence here is the failure this whole file exists to prevent: an
        // unchecked runtime renders identically to a checked one that passed.
        const presets = parsePresets(manyPresets([
          ...mentionsRemoved,
          presetBlock('cc-preset', 'claude-code', '    prompt: `Call commonly_post_message.`,'),
        ]));
        const { missing, uncovered } = checkPresetToolNames({ presets, sets });
        expect(missing).toHaveLength(0);
        expect(uncovered).toHaveLength(1);
        expect(uncovered[0].preset.runtime).toBe('claude-code');
        expect(uncovered[0].names).toContain('commonly_post_message');
      });

      it('exempts the names presets.ts mentions only to say they were removed', () => {
        const presets = parsePresets(manyPresets(mentionsRemoved));
        expect(checkPresetToolNames({ presets, sets }).missing).toHaveLength(0);
      });

      it('refuses an exemption that outlives the sentence justifying it', () => {
        // Same self-check as namedForOtherDrivers: an exclusion nobody revisits
        // silently widens into a licence for a future real use of the name.
        const presets = parsePresets(manyPresets());
        expect(() => checkPresetToolNames({ presets, sets }))
          .toThrow(/no longer mentions it/);
      });
    });

    describe('readExtensionToolsAtPin', () => {
      it('reads the extension at the gitlink pin, not at the submodule working tree', () => {
        const calls = [];
        const exec = jest.fn((_bin, args) => {
          calls.push(args);
          return 'name: "commonly_post_message",';
        });
        const result = readExtensionToolsAtPin({ exec });
        expect(result.ok).toBe(true);
        // The revision handed to `git show` is the gitlink sha resolved from
        // HEAD — never an implicit read of whatever the submodule tree is on.
        const show = calls.find((c) => c.includes('show'));
        expect(show[show.indexOf('show') + 1])
          .toBe(`${readGitlinkSha({ full: true })}:extensions/commonly/src/tools.ts`);
        expect(result.pin).toBe(readGitlinkSha({ full: true }));
      });

      it('surfaces the failure rather than falling back to the working tree', () => {
        // The fallback is omitted on purpose. The two lineages declare identical
        // tool names, so an off-pin read AGREES with a correct one — a
        // wrong-provenance measurement returning the right answer, which is
        // exactly how this defect survived being looked at.
        const exec = jest.fn(() => {
          throw Object.assign(new Error('fatal: path does not exist'), { status: 128 });
        });
        const result = readExtensionToolsAtPin({ exec });
        expect(result.ok).toBe(false);
        expect(result.text).toBeUndefined();
        expect(result.reason).toMatch(/fatal: path does not exist/);
      });
    });
  });
});
