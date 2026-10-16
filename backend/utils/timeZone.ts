// An IANA time zone name as a browser reports it
// (Intl.DateTimeFormat().resolvedOptions().timeZone), kept only if this
// runtime knows it, in its canonical spelling. Used to send the daily digest
// at 08:00 in the person's own day (services/dailyDigestService.ts).
const TIME_ZONE_SHAPE = /^[A-Za-z0-9_+\-/]{1,64}$/;

const cleanTimeZone = (raw: unknown): string | undefined => {
  const zone = typeof raw === 'string' ? raw.trim() : '';
  if (!TIME_ZONE_SHAPE.test(zone)) return undefined;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
};

/** The hour (0-23) it is now in that zone. */
const localHour = (zone: string, at: Date): number => {
  const hour = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(at).find((part) => part.type === 'hour');
  return Number(hour?.value);
};

module.exports = { cleanTimeZone, localHour };

export {};
