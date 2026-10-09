/**
 * upstream-refusal.test.mjs — TASK-096.
 *
 * Every fixture in the "measured" block is a VERBATIM line from a real pi run
 * against a local route, captured 2026-09-22 (pi 0.84.1, this host). They are
 * here because the shapes differ from the ones the row assumed: `finalError`
 * carries no colon when the body is HTML, a 401 is never retried so it reports
 * on `message_end` alone, and LiteLLM's budget refusal puts its text at a
 * top-level `message`, not under `error`.
 */


const {
  MAX_REFUSAL_DETAIL,
  bodyFromError,
  describeUpstreamRefusal,
  keptRefusalDetail,
  readUpstreamRefusal,
  redactKnownCredentials,
  spawnCredentials,
  statusFromError,
} = await import('../src/lib/upstream-refusal.js');

const KEY = 'sk-kai-test-secret-value';
const SEAT_TOKEN = 'cm_agent_9900000000000000000000000000000000000000000000000000000000000000';

// ── measured 2026-09-22 ──────────────────────────────────────────────────────

const budget429 = '{"type":"auto_retry_end","success":false,"attempt":3,"finalError":"429: {\\"message\\":\\"Budget has been exceeded! Current cost: 12.34, Max budget: 10.00\\",\\"type\\":\\"budget_exceeded\\",\\"code\\":\\"429\\"}"}';
const html502 = '{"type":"auto_retry_end","success":false,"attempt":3,"finalError":"502 <html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>"}';
const echo401 = `{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"401: {\\"message\\":\\"Invalid API key provided: ${KEY}. You can find your key at /settings/keys\\"}"}}`;
const messageEndError = '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"503: {\\"message\\":\\"upstream connect error\\"}"}}';

const asLines = (...events) => `${events.join('\n')}\n`;

describe('statusFromError and bodyFromError', () => {
  test('a JSON body carries a colon and an HTML body does not — both are read', () => {
    // Measured: the same pi build emits `429: {…}` and `502 <html>…`.
    expect(statusFromError('429: {"message":"x"}')).toBe(429);
    expect(bodyFromError('429: {"message":"x"}')).toBe('{"message":"x"}');
    expect(statusFromError('502 <html>nginx</html>')).toBe(502);
    expect(bodyFromError('502 <html>nginx</html>')).toBe('<html>nginx</html>');
  });

  test('a leading number that is not a 4xx/5xx is not a status, and the text is left whole', () => {
    expect(statusFromError('4040 tokens over budget')).toBeNull();
    expect(statusFromError('200 OK')).toBeNull();
    expect(statusFromError('fetch failed')).toBeNull();
    expect(bodyFromError('4040 tokens over budget')).toBe('4040 tokens over budget');
    expect(bodyFromError('fetch failed')).toBe('fetch failed');
  });

  test('a colon inside the body is not mistaken for the separator', () => {
    expect(bodyFromError('429: {"message":"cost: 12.34"}')).toBe('{"message":"cost: 12.34"}');
  });
});

describe('the keep-list', () => {
  test("LiteLLM's budget refusal keeps its message — the case the row was filed for", () => {
    // Top-level `message`, NOT `error.message`. A keep-list that kept only
    // `error.message` would report "upstream refused 429" with no budget line,
    // which is the incident this row exists to explain.
    expect(keptRefusalDetail('{"message":"Budget has been exceeded! Current cost: 12.34, Max budget: 10.00","type":"budget_exceeded","code":"429"}'))
      .toBe('Budget has been exceeded! Current cost: 12.34, Max budget: 10.00');
  });

  test('an OpenAI-shaped error keeps `error.message`', () => {
    expect(keptRefusalDetail('{"error":{"message":"invalid_request_error","type":"invalid_request_error"}}'))
      .toBe('invalid_request_error');
  });

  test('HTML keeps nothing, so the status stands alone', () => {
    expect(keptRefusalDetail('<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>')).toBeNull();
  });

  test('a JSON body with neither field keeps nothing rather than guessing a field', () => {
    expect(keptRefusalDetail('{"type":"budget_exceeded","code":"429"}')).toBeNull();
    expect(keptRefusalDetail('["429"]')).toBeNull();
    expect(keptRefusalDetail('{"message":{"nested":"not a string"}}')).toBeNull();
    expect(keptRefusalDetail('')).toBeNull();
  });

  test('a body echoing a credential this spawn was handed keeps nothing', () => {
    const raw = `{"message":"Invalid API key provided: ${KEY}. You can find your key at /settings/keys"}`;
    expect(keptRefusalDetail(raw, { credentials: [KEY] })).toBeNull();
    // The seat's own token is checked the same way, and a value we do not hold
    // is not guessed at — the text is kept when nothing matches.
    expect(keptRefusalDetail(`{"message":"got ${SEAT_TOKEN}"}`, { credentials: [SEAT_TOKEN] })).toBeNull();
    expect(keptRefusalDetail(raw, { credentials: ['some-other-credential-value'] }))
      .toBe(`Invalid API key provided: ${KEY}. You can find your key at /settings/keys`);
  });

  test('a kept detail is truncated to the cap, ellipsis included', () => {
    const long = 'a'.repeat(500);
    const kept = keptRefusalDetail(JSON.stringify({ message: long }));
    expect(kept.length).toBe(MAX_REFUSAL_DETAIL);
    expect(kept.endsWith('…')).toBe(true);
    expect(kept.slice(0, -1)).toBe('a'.repeat(MAX_REFUSAL_DETAIL - 1));
  });

  test('runs of whitespace collapse, so a multi-line body stays one log line', () => {
    expect(keptRefusalDetail('{"message":"first\\n\\n  second\\tthird"}')).toBe('first second third');
  });
});

describe('readUpstreamRefusal', () => {
  test('a retried refusal reports its status and its body', () => {
    expect(readUpstreamRefusal(asLines('{"type":"agent_start"}', budget429))).toEqual({
      status: 429,
      detail: 'Budget has been exceeded! Current cost: 12.34, Max budget: 10.00',
    });
  });

  test('a 401 is never retried, so it reports off message_end alone', () => {
    // Measured: no `auto_retry_end` line exists in this stream at all.
    const refusal = readUpstreamRefusal(asLines(echo401), { credentials: [KEY] });
    expect(refusal).toEqual({ status: 401, detail: null });
  });

  test('an HTML 502 reports the status with no detail', () => {
    expect(readUpstreamRefusal(asLines(html502))).toEqual({ status: 502, detail: null });
  });

  test('auto_retry_end is the terminal word, and it wins over the attempts before it', () => {
    const refusal = readUpstreamRefusal(asLines(messageEndError, budget429));
    expect(refusal).toEqual({
      status: 429,
      detail: 'Budget has been exceeded! Current cost: 12.34, Max budget: 10.00',
    });
  });

  test('a stream that refused nothing has no refusal', () => {
    expect(readUpstreamRefusal(asLines('{"type":"agent_start"}', '{"type":"agent_settled"}'))).toBeNull();
    expect(readUpstreamRefusal('not json at all\n')).toBeNull();
    expect(readUpstreamRefusal('')).toBeNull();
  });

  test('a successful auto retry is not a refusal', () => {
    expect(readUpstreamRefusal(asLines('{"type":"auto_retry_end","success":true,"attempt":1}'))).toBeNull();
  });
});

describe('redactKnownCredentials and spawnCredentials', () => {
  test('a known value is replaced; a short string is not, so ordinary prose survives', () => {
    expect(redactKnownCredentials(`token ${KEY} here`, [KEY])).toBe('token [redacted] here');
    expect(redactKnownCredentials('the number 12 appears', ['12'])).toBe('the number 12 appears');
    expect(redactKnownCredentials('untouched', [null, undefined, 7])).toBe('untouched');
  });

  test('the spawn credential list is the seat token plus the declared provider keys, and nothing guessed', () => {
    const ctx = { runtimeToken: SEAT_TOKEN, env: { LITELLM_VIRTUAL_KEY: KEY, UNRELATED: 'x' } };
    expect(spawnCredentials(ctx, ['LITELLM_VIRTUAL_KEY'])).toEqual([SEAT_TOKEN, KEY]);
    expect(spawnCredentials(ctx, [])).toEqual([SEAT_TOKEN]);
    expect(spawnCredentials({ env: {} }, ['MISSING'])).toEqual([]);
  });
});

describe('describeUpstreamRefusal', () => {
  test('names the status always, and the body only when one was kept', () => {
    expect(describeUpstreamRefusal({ status: 429, detail: 'Budget has been exceeded!' }))
      .toBe('upstream refused 429: Budget has been exceeded!');
    expect(describeUpstreamRefusal({ status: 502, detail: null })).toBe('upstream refused 502');
  });

  test('the named status is greppable — the property the old log line lacked', () => {
    expect(describeUpstreamRefusal({ status: 401, detail: null })).toMatch(/^upstream refused \d{3}/);
  });

  test('no refusal, no line', () => {
    expect(describeUpstreamRefusal(null)).toBeNull();
    expect(describeUpstreamRefusal({ detail: 'no status' })).toBeNull();
  });
});
