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
 */

const {
  CONTROL_VAR, envEntries, classifyEnvRead, describeVerdict,
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
});
