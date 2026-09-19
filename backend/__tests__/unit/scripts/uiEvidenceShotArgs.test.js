/**
 * Guards the argument contract of scripts/ui-evidence-shot.mjs (the parser lives in
 * scripts/lib/ui-evidence-args.js so this can run without a browser).
 *
 * Two defects, one class: the harness did the silent thing with input it did not
 * understand. It had no `--width` and dropped the flag, so `--width 390` wrote a
 * 1440x900 capture under a `-390` name (2026-09-19, review-checklist rule 27). With
 * that fixed, a value belonging to no flag was still skipped without a word -
 * `--width 390 400` ran with 390 and never mentioned the 400, and a route passed
 * positionally was ignored as if `--route` had been given (Vera read both out of
 * the harness during the review, 70101/70102).
 */

const {
  KNOWN_FLAGS, parseArgs, refusalFor,
} = require('../../../../scripts/lib/ui-evidence-args');

const refusal = (argv) => refusalFor(parseArgs(argv));

describe('ui-evidence-shot argument contract', () => {
  test('a value that belongs to no flag is refused, and named', () => {
    const message = refusal(['--route', '/v2/connectors', '--width', '390', '400', '--out', '/tmp/a.png']);
    expect(message).toMatch(/unexpected value\(s\): 400/);
    // Refused, not repaired: 390 was already parsed, and the run must not proceed.
    expect(refusal(['--width', '390', '400'])).not.toBeNull();
  });

  test('a route passed positionally is refused rather than ignored', () => {
    const message = refusal(['/v2/pods/team/abc', '--out', '/tmp/a.png']);
    expect(message).toMatch(/unexpected value\(s\): \/v2\/pods\/team\/abc/);
  });

  test('the value after a flag is that flag\'s value, not a stray', () => {
    const { values, stray } = parseArgs(['--width', '390', '--out', '/tmp/a.png']);
    expect(values.get('width')).toBe('390');
    expect(values.get('out')).toBe('/tmp/a.png');
    expect(stray).toEqual([]);
    expect(refusalFor({ values, stray })).toBeNull();
  });

  test('the joined form parses as the same flag', () => {
    const { values, stray } = parseArgs(['--width=390', '--route=/v2/connectors']);
    expect(values.get('width')).toBe('390');
    expect(values.get('route')).toBe('/v2/connectors');
    expect(refusalFor({ values, stray })).toBeNull();
  });

  test('a flag with no value is a boolean, not a stray', () => {
    const { values, stray } = parseArgs(['--click']);
    expect(values.get('click')).toBe('true');
    expect(stray).toEqual([]);
  });

  test('an unknown flag is refused, and the message lists what is known', () => {
    const message = refusal(['--widht', '390']);
    expect(message).toMatch(/unknown flag\(s\): --widht/);
    for (const flag of KNOWN_FLAGS) expect(message).toContain(`--${flag}`);
  });

  test('both mistakes are reported in one message', () => {
    const message = refusal(['--widht', '390', '--out', '/tmp/a.png', 'extra']);
    expect(message).toMatch(/unknown flag\(s\): --widht/);
    expect(message).toMatch(/unexpected value\(s\): extra/);
  });

  test('a fully known invocation is not refused', () => {
    const argv = [
      '--route', '/v2/connectors', '--out', '/tmp/a.png', '--base-url', 'http://localhost:3000',
      '--api', 'http://localhost:5050', '--width', '390', '--height', '900',
      '--selector', '.tools-trail', '--click', 'button', '--wait', '2500',
      '--email', 'dev@commonly.local', '--password', 'password123', '--token', 'jwt',
    ];
    expect(refusal(argv)).toBeNull();
    expect(parseArgs(argv).stray).toEqual([]);
  });
});
