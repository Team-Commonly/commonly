const { Writable } = require('stream');
const {
  makeRedactor,
  patchStream,
  collectSecrets,
  installStreamEnvRedaction,
} = require('../../utils/redactEnv');

describe('redactEnv', () => {
  describe('collectSecrets', () => {
    it('selects secret-named vars with a long-enough value and skips the rest', () => {
      const names = collectSecrets({
        CLAUDE_CODE_MESSAGING_TOKEN: 'cc-msg-abcdefghijklmnop',
        GITHUB_PAT: 'ghp_abcdefghij',
        PG_PASSWORD: 'postgres-pw-123',
        MONGO_URI: 'mongodb://u:p@host/db',
        LITELLM_API_KEY: 'sk-litellm-abcdef',
        REACT_APP_API_URL: 'https://api.commonly.me',
        PATH: '/usr/bin:/bin',
        SSH_AUTH_SOCK: '/private/tmp/agent.sock',
        SHORT_TOKEN: 'abc',
        EMPTY_SECRET: '',
      }).map(([n]) => n);

      expect(names).toEqual(expect.arrayContaining([
        'CLAUDE_CODE_MESSAGING_TOKEN', 'GITHUB_PAT', 'PG_PASSWORD', 'MONGO_URI', 'LITELLM_API_KEY',
      ]));
      // public URL, a path, and AUTH-named socket are NOT secret-named
      expect(names).not.toContain('REACT_APP_API_URL');
      expect(names).not.toContain('PATH');
      expect(names).not.toContain('SSH_AUTH_SOCK');
      // below MIN_SECRET_LEN
      expect(names).not.toContain('SHORT_TOKEN');
      expect(names).not.toContain('EMPTY_SECRET');
    });

    it('orders by value length, longest first', () => {
      const pairs = collectSecrets({
        A_TOKEN: 'short-value-1',
        B_SECRET: 'a-much-longer-secret-value-here',
      });
      expect(pairs[0][0]).toBe('B_SECRET');
    });
  });

  describe('makeRedactor', () => {
    it('replaces a secret value with [REDACTED:<NAME>] at every occurrence', () => {
      const redact = makeRedactor({ FAKE_TOKEN: 'super-secret-value-123' });
      const out = redact('a super-secret-value-123 b super-secret-value-123 c');
      expect(out).toBe('a [REDACTED:FAKE_TOKEN] b [REDACTED:FAKE_TOKEN] c');
      expect(out).not.toContain('super-secret-value-123');
    });

    it('leaves non-secret env values untouched', () => {
      const redact = makeRedactor({
        API_URL: 'https://api.commonly.me',
        FAKE_TOKEN: 'super-secret-value-123',
      });
      expect(redact('url https://api.commonly.me stays')).toBe('url https://api.commonly.me stays');
    });

    it('is identity when there is nothing to redact', () => {
      const redact = makeRedactor({ PATH: '/usr/bin', NODE_ENV: 'test' });
      expect(redact('plain text')).toBe('plain text');
    });

    it('escapes regex metacharacters in the secret value', () => {
      const redact = makeRedactor({ CONN_SECRET: 'a+b(c)[d].e' });
      expect(redact('x a+b(c)[d].e y')).toBe('x [REDACTED:CONN_SECRET] y');
    });
  });

  describe('patchStream', () => {
    it('redacts string writes, passes buffers through, and unpatch restores', () => {
      const chunks = [];
      // decodeStrings:false so _write receives the original string, not a Buffer
      const sink = new Writable({ decodeStrings: false, write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
      const redact = makeRedactor({ FAKE_TOKEN: 'super-secret-value-123' });
      const unpatch = patchStream(sink, redact);

      sink.write('token is super-secret-value-123\n');
      const buf = Buffer.from('super-secret-value-123');
      sink.write(buf);

      expect(chunks[0]).toBe('token is [REDACTED:FAKE_TOKEN]\n');
      expect(chunks[1]).toBe(buf); // buffer passed through untouched (same ref)

      unpatch();
      sink.write('super-secret-value-123 now visible');
      expect(chunks[2]).toBe('super-secret-value-123 now visible');
    });

    it('does not stack a second wrapper; one unpatch fully restores', () => {
      const chunks = [];
      const sink = new Writable({ decodeStrings: false, write(c, _e, cb) { chunks.push(c); cb(); } });
      const redact = makeRedactor({ FAKE_TOKEN: 'super-secret-value-123' });
      const u1 = patchStream(sink, redact);
      const u2 = patchStream(sink, redact); // second call must not wrap again
      expect(u2).toBe(u1);
      u1(); // a single unpatch fully restores -> proves one wrapper, not two
      sink.write('super-secret-value-123 visible');
      expect(chunks[0]).toBe('super-secret-value-123 visible');
    });
  });

  describe('installStreamEnvRedaction', () => {
    it('is idempotent on the shared process streams (setup.js already installed it)', () => {
      // setup.js installs the guard in every worker, so a re-install is a no-op
      expect(installStreamEnvRedaction()).toBe(false);
    });
  });
});
