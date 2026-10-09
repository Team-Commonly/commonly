/**
 * Guards the verdict rule of the seat-credential-delivery check (the classifier
 * lives in scripts/lib/credential-env-read.js so this can run without a process
 * tree).
 *
 * One defect, one class: the acceptance for the credential-withholding change
 * (#1801) reads a spawned adapter child's environment and asserts the runtime
 * token is not in it - and `ps eww` returns no environment at all for some
 * processes, without saying so (measured 2026-09-20: 75-96 bytes, argv only, for
 * `/bin/sleep`, `/bin/bash -c` and the live pi adapter child, against 8606 bytes
 * with `PATH=` present for the codex adapter child on the same command), so the
 * check as written returned the desired answer on an empty read. An empty read
 * must therefore be `unreadable`, and only a read proven live by a control
 * variable may ever produce `token_withheld`.
 *
 * Route 2 (the child reporting its own environment, `--self-report`) shares the
 * parser and the verdict words but not the gate: a process reading itself cannot
 * read nothing, so its withheld verdict stands without a control and the control is
 * reported as context. Both routes test the criterion as written - no `cm_agent_`
 * value under ANY variable name - so these tests cover a credential that moved to a
 * name the check was not keyed on.
 */

const {
  CONTROL_VAR, envEntries, classifyEnvRead, classifySelfReport, describeVerdict, describeSelfReport,
  describeAncestry, isPlaced, selfReportExit,
} = require('../../../../scripts/lib/credential-env-read');
describe('seat credential delivery env reading', () => {
  test('an empty read is UNREADABLE, never a withheld token', () => {
    // The measured shape: `ps eww` for a sandboxed child returns header + argv only.
    const raw = '  PID TTY           TIME CMD\n58178   ??  S      0:02.45 pi                     ';
    const r = classifyEnvRead(raw);
    expect(r.verdict).toBe('unreadable');
    expect(r.verdict).not.toBe('token_withheld');
    expect(r.readable).toBe(false);
  });

  test('a read proven live by the control variable can conclude the token is withheld', () => {
    const raw = 'PATH=/usr/bin:/bin HOME=/Users/x TMPDIR=/var/folders/x';
    const r = classifyEnvRead(raw);
    expect(r.controlPresent).toBe(true);
    expect(r.verdict).toBe('token_withheld');
    expect(r.filePresent).toBe(false);
  });

  test('a present token is reported as present, control or not', () => {
    // Finding the variable is itself proof the read reached the block, and it is
    // the outcome nobody is hoping for, so no control is required for it.
    expect(classifyEnvRead('PATH=/bin COMMONLY_AGENT_TOKEN=cm_agent_abc').verdict).toBe('token_present');
    expect(classifyEnvRead('COMMONLY_AGENT_TOKEN=cm_agent_abc').verdict).toBe('token_present');
  });

  test('the declared file variable is reported alongside the verdict', () => {
    const r = classifyEnvRead('PATH=/bin COMMONLY_TOKEN_FILE=/tmp/spawn-1/credential');
    expect(r.verdict).toBe('token_withheld');
    expect(r.filePresent).toBe(true);
  });

  test('control and token variables are configurable, so a renamed surface is not silently green', () => {
    const raw = 'MY_CONTROL=1';
    expect(classifyEnvRead(raw, { controlVar: 'MY_CONTROL' }).verdict).toBe('token_withheld');
    expect(classifyEnvRead(raw, { controlVar: 'OTHER' }).verdict).toBe('unreadable');
    expect(classifyEnvRead('PATH=/bin RUNTIME_TOKEN=x', { tokenVar: 'RUNTIME_TOKEN' }).verdict).toBe('token_present');
  });

  test('the sentence for an unreadable read says what it does not prove', () => {
    const line = describeVerdict({ seat: 'kai', adapter: 'pi', pid: 58178, raw: 'header only' });
    expect(line).toMatch(/UNREADABLE/);
    expect(line).toMatch(/NOT a withheld token/);
    const withheld = describeVerdict({ seat: 'otto', adapter: 'claude', pid: 1, raw: 'PATH=/bin' });
    expect(withheld).toMatch(/token withheld/);
    expect(withheld).toMatch(new RegExp(CONTROL_VAR));
    const present = describeVerdict({ seat: 'quill', adapter: 'codex', pid: 2, raw: 'PATH=/bin COMMONLY_AGENT_TOKEN=x' });
    expect(present).toMatch(/TOKEN PRESENT/);
  });

  test('only well-formed assignments count, and the first value wins', () => {
    const entries = envEntries('PATH=/bin 2FAKE=x _ok=1 COMMONLY=1 LOG="a b" PATH=/second');
    expect(entries.has('PATH')).toBe(true);
    expect(entries.get('PATH')).toBe('/bin');
    expect(entries.has('2FAKE')).toBe(false);
  });

  test('route 1 flags a credential under an unexpected variable name too', () => {
    // The criterion is "no cm_agent_ value in any child environment", not "the
    // declared token variable is absent" - a value that moved to another name is
    // the same leak, and a check keyed on one name would report withheld.
    const r = classifyEnvRead('PATH=/bin COMMONLY_AGENT_SESSION=cm_agent_abc');
    expect(r.verdict).toBe('token_present');
    expect(r.credentialValueVars).toEqual(['COMMONLY_AGENT_SESSION']);
    expect(classifyEnvRead('PATH=/bin').credentialValueVars).toEqual([]);
  });

  test('route 2 (self-report) does not gate a withheld verdict on the control', () => {
    // A process reading itself cannot read nothing, so the control is context
    // here, not a gate - the route-1 rule would call this unreadable.
    const r = classifySelfReport({ COMMONLY_TOKEN_FILE: '/tmp/spawn-1/credential', HOME: '/Users/x' });
    expect(r.verdict).toBe('token_withheld');
    expect(r.controlPresent).toBe(false);
    expect(r.filePresent).toBe(true);
    expect(describeSelfReport({ seat: 'kai', adapter: 'pi', env: r && { COMMONLY_TOKEN_FILE: '/x' } })).toMatch(/route 2 \(self-report\) — token withheld/);
  });

  test('route 2 reports a present credential even with no control variable', () => {
    // The mutation ledger found this one: without it, gating route 2's verdict on
    // the control variable SURVIVED, because a withheld fixture answers the same
    // either way. The direction that matters is a credential that IS there and a
    // control that is not - it must be reported, not explained away.
    expect(classifySelfReport({ COMMONLY_AGENT_TOKEN: 'cm_agent_x' }).verdict).toBe('token_present');
    expect(classifySelfReport({ FOO: 'cm_agent_y' }).verdict).toBe('token_present');
  });

  test('route 2 prints where it ran, and checks its label against that chain', () => {
    // The verdict is about *some* process: `--seat` is a label the reporter never
    // verifies, so the line carries pid/ppid + the parent argv chain (wren 70593)
    // and the label is checked against that chain rather than asserted.
    const chain = [
      { pid: 500, ppid: 499, args: 'node scripts/verify-seat-credential-delivery.mjs --seat kai --self-report' },
      { pid: 499, ppid: 300, args: '/bin/bash -c node scripts/verify-seat-credential-delivery.mjs --seat kai' },
      { pid: 300, ppid: 100, args: 'pi' },
      { pid: 100, ppid: 1, args: '/opt/homebrew/bin/node /opt/homebrew/bin/commonly agent run kai' },
    ];
    const line = describeSelfReport({ seat: 'kai', adapter: 'pi', env: { PATH: '/bin' }, ancestry: chain });
    expect(line).toMatch(/pid=500 ppid=499/);
    expect(line).toMatch(/300 pi <- 100 \/opt\/homebrew\/bin\/node/);
    // The invocation's own argv contains `--seat kai`; matching that would confirm
    // the label with the label, so the match must land on the supervisor instead,
    // and only in the shape the launcher itself uses: `agent run <seat>`.
    expect(line).toMatch(/seat label "kai" is the seat argument of ancestor pid 100/);
    expect(line).not.toMatch(/pid 499/);
    // And a label nothing in the chain carries is reported as unverified.
    const wrong = describeSelfReport({ seat: 'otto', adapter: 'claude', env: { PATH: '/bin' }, ancestry: chain });
    expect(wrong).toMatch(/seat label "otto" does NOT appear in any ancestor argv/);

    expect(isPlaced({ seat: 'kai', ancestry: chain })).toBe(true);

    // wren 70599: a claude seat's ancestor is `claude -p <whole prompt>`, pod text
    // included, so a label naming any seat the prompt mentions looks present. The
    // prompt is not the launcher, and the four-token shape can be quoted inside it.
    const promptAncestry = (promptTail) => [
      { pid: 10, ppid: 9, args: 'node scripts/verify-seat-credential-delivery.mjs --seat kai --self-report' },
      { pid: 9, ppid: 8, args: `claude -p You are kai in pod 6a8f6dc7. ${promptTail}` },
    ];
    const mentioned = describeAncestry({ seat: 'kai', ancestry: promptAncestry('Nobody typed your @name.') });
    expect(mentioned).not.toMatch(/is the seat argument/);
    expect(mentioned).toMatch(/standalone token in ancestor pid 9/);
    expect(isPlaced({ seat: 'kai', ancestry: promptAncestry('x') })).toBe(false);
    // Pod text quoting the launcher verbatim — the tokens line up, and only the
    // prompt-bearing check keeps this from confirming.
    const quoted = promptAncestry('the CLI is started by commonly agent run kai at boot');
    expect(describeAncestry({ seat: 'kai', ancestry: quoted })).toMatch(/PROMPT-BEARING argv \(pid 9\)/);
    expect(describeAncestry({ seat: 'kai', ancestry: quoted })).not.toMatch(/is the seat argument/);
    expect(isPlaced({ seat: 'kai', ancestry: quoted })).toBe(false);
    // The more usual quoting style breaks the token sequence anyway; both are
    // reported as not confirmed rather than as a pass.
    const ticked = promptAncestry('the CLI runs `commonly agent run kai` at boot');
    expect(describeAncestry({ seat: 'kai', ancestry: ticked })).not.toMatch(/is the seat argument/);
    expect(describeAncestry({ seat: 'kai', ancestry: ticked })).toMatch(/NOT confirmed/);
    expect(isPlaced({ seat: 'kai', ancestry: ticked })).toBe(false);

    // vera 70596, reproduced live: `args.includes(seat)` confirms labels that are
    // wrong - `--seat commonly`, `--seat run`, `--seat node` all matched the
    // supervisor's own command line by substring. A name inside a path is not the
    // seat, and a standalone token is not the seat either.
    const path = [
      { pid: 10, ppid: 9, args: 'node scripts/verify-seat-credential-delivery.mjs --seat agents --self-report' },
      { pid: 9, ppid: 8, args: '/bin/zsh -c cd /Users/xcjsam/agents/kai/commonly && node scripts/x.mjs' },
    ];
    const inPath = describeAncestry({ seat: 'agents', ancestry: path });
    expect(inPath).not.toMatch(/is the seat argument/);
    expect(inPath).not.toMatch(/standalone token/);
    expect(inPath).toMatch(/does NOT appear in any ancestor argv/);
    // The invocation's own argv always contains `--seat <seat>`. If the exclusion
    // is dropped, that argv becomes the token candidate and the line attributes the
    // report to the bash that launched the probe instead of to a real ancestor.
    const invocationOnly = [
      { pid: 10, ppid: 9, args: 'node scripts/verify-seat-credential-delivery.mjs --seat kai --self-report' },
      { pid: 9, ppid: 8, args: '/bin/bash -c node scripts/verify-seat-credential-delivery.mjs --seat kai' },
    ];
    const noRealAncestor = describeAncestry({ seat: 'kai', ancestry: invocationOnly });
    expect(noRealAncestor).toMatch(/does NOT appear in any ancestor argv/);
    expect(noRealAncestor).not.toMatch(/standalone token/);
    const binary = [
      { pid: 10, ppid: 9, args: 'node scripts/verify-seat-credential-delivery.mjs --seat pi --self-report' },
      { pid: 9, ppid: 8, args: 'pi' },
    ];
    const tokenOnly = describeAncestry({ seat: 'pi', ancestry: binary });
    expect(tokenOnly).toMatch(/appears only as a standalone token in ancestor pid 9 \(pi\)/);
    expect(tokenOnly).toMatch(/NOT confirmed/);
    expect(tokenOnly).not.toMatch(/is the seat argument/);
    // No chain (a copy-pasted verdict) still reports the verdict, without a claim
    // about where it was made.
    const bare = describeSelfReport({ seat: 'kai', env: { PATH: '/bin' } });
    expect(bare).not.toMatch(/started under/);
  });

  test('route 2 finds the credential under any name, and says which one', () => {
    const named = classifySelfReport({ PATH: '/bin', COMMONLY_AGENT_TOKEN: 'cm_agent_x' });
    expect(named.verdict).toBe('token_present');
    expect(named.credentialValueVars).toEqual(['COMMONLY_AGENT_TOKEN']);
    const renamed = classifySelfReport({ PATH: '/bin', FOO: 'cm_agent_y' });
    expect(renamed.verdict).toBe('token_present');
    expect(describeSelfReport({ seat: 'otto', adapter: 'claude', env: { PATH: '/bin', FOO: 'cm_agent_y' } })).toMatch(/under FOO/);
    // The declared file variable names a path, not a secret: it must not fail the check.
    expect(classifySelfReport({ PATH: '/bin', COMMONLY_TOKEN_FILE: '/tmp/spawn-1/credential' }).verdict).toBe('token_withheld');
  });

  test('route 2 exits non-zero when it cannot place the report (wren 70600)', () => {
    // A withheld verdict about a process nobody located is the same shape of
    // non-answer as route 1's blind read, so it must not exit 0.
    expect(selfReportExit({ verdict: 'token_withheld', placed: true })).toBe(0);
    expect(selfReportExit({ verdict: 'token_withheld', placed: false })).toBe(1);
    expect(selfReportExit({ verdict: 'token_present', placed: false })).toBe(3);
    expect(selfReportExit({ verdict: 'token_present', placed: true })).toBe(3);
  });

  test('the --self-report route is wired end to end, with the env passed explicitly', () => {
    // Route 2 is the route for seats whose child route 1 cannot read, so the flag
    // itself is part of the instrument. The child's env is passed explicitly:
    // mutating process.env here would not reach a spawned child.
    const { spawnSync } = require('child_process');
    const path = require('path');
    const script = path.join(__dirname, '../../../../scripts/verify-seat-credential-delivery.mjs');
    const base = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
    const withheld = spawnSync(process.execPath, [script, '--seat', 'test-seat', '--self-report'], {
      env: { ...base, COMMONLY_TOKEN_FILE: '/tmp/spawn-1/credential' }, encoding: 'utf8',
    });
    // This test process is not a `commonly agent run` launcher, so the report is
    // UNPLACED and the exit code is 1, not 0 — the case wren held the PR on.
    expect(withheld.status).toBe(1);
    expect(withheld.stdout).toMatch(/UNPLACED/);
    expect(withheld.stdout).toMatch(/route 2 \(self-report\) — token withheld/);
    expect(withheld.stdout).toMatch(/test-seat/);
    // The chain is read from the real process tree, so this asserts the reader
    // itself: the child's parent is this test process.
    expect(withheld.stdout).toMatch(new RegExp(`ppid=${process.pid}\\b`));
    expect(withheld.stdout).toMatch(/started under:/);
    expect(withheld.stdout).toMatch(/seat label "test-seat" does NOT appear in any ancestor argv/);
    const present = spawnSync(process.execPath, [script, '--seat', 'test-seat', '--self-report'], {
      env: { ...base, COMMONLY_AGENT_TOKEN: 'cm_agent_leaked' }, encoding: 'utf8',
    });
    expect(present.status).toBe(3);
    expect(present.stdout).toMatch(/TOKEN PRESENT under COMMONLY_AGENT_TOKEN/);
    expect(present.stdout).not.toMatch(/cm_agent_leaked/);
  });
});
