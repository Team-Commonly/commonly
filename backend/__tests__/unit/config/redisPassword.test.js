// The shared Redis password helper must trim REDIS_PASSWORD so a secret written
// to Secret Manager with a trailing newline (echo | --data-file=-) still
// authenticates. Redis's conf tokenizer strips the newline server-side, so an
// untrimmed client sends a value the server never has -> WRONGPASS. This is the
// exact staging failure of 2026-11-04. Blank/unset must stay undefined so the
// local/dev no-auth path is unchanged.

const { redisPassword } = require('../../../config/redisPassword');

describe('redisPassword()', () => {
  const saved = process.env.REDIS_PASSWORD;
  afterEach(() => {
    if (saved === undefined) delete process.env.REDIS_PASSWORD;
    else process.env.REDIS_PASSWORD = saved;
  });

  it('trims a trailing newline so a secret written with echo still authenticates', () => {
    process.env.REDIS_PASSWORD = 'abcdef0123456789\n';
    expect(redisPassword()).toBe('abcdef0123456789');
  });

  it('trims surrounding whitespace', () => {
    process.env.REDIS_PASSWORD = '  pw  ';
    expect(redisPassword()).toBe('pw');
  });

  it('returns undefined when unset (local/dev no-auth path)', () => {
    delete process.env.REDIS_PASSWORD;
    expect(redisPassword()).toBeUndefined();
  });

  it('returns undefined when blank or whitespace-only', () => {
    process.env.REDIS_PASSWORD = '  \n';
    expect(redisPassword()).toBeUndefined();
  });
});
