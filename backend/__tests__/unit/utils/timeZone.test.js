const { cleanTimeZone, localHour } = require('../../../utils/timeZone');

describe('cleanTimeZone', () => {
  it('keeps a zone this runtime knows, in its canonical spelling', () => {
    expect(cleanTimeZone('America/Los_Angeles')).toBe('America/Los_Angeles');
    // ICU may answer with a link's older name (Node 22: Asia/Kolkata -> Asia/Calcutta); either is the same zone.
    expect(['Asia/Kolkata', 'Asia/Calcutta']).toContain(cleanTimeZone(' Asia/Kolkata '));
    expect(cleanTimeZone('UTC')).toBe('UTC');
  });

  it.each([
    ['an unknown zone', 'Mars/Phobos'],
    ['markup', '<b>UTC</b>'],
    ['too long', `America/${'x'.repeat(70)}`],
    ['an object', { $gt: '' }],
    ['empty', ''],
  ])('drops %s', (_label, raw) => {
    expect(cleanTimeZone(raw)).toBeUndefined();
  });
});

describe('localHour', () => {
  it('reads the hour in that zone, half-hour zones included', () => {
    const at = new Date('2026-10-17T15:00:00Z');
    expect(localHour('America/Los_Angeles', at)).toBe(8); // PDT, UTC-7
    expect(localHour('UTC', at)).toBe(15);
    expect(localHour('Asia/Kolkata', new Date('2026-10-17T03:01:00Z'))).toBe(8); // 08:31, UTC+5:30
  });
});
