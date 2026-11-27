import { waitFor } from '@testing-library/react';

// F679. Under fake timers, waitFor and findBy advance fake time in 50 ms
// rounds. A state update that lands outside act (a mocked request resolving
// mid-wait) goes to React's scheduler, which runs it on the real timer it
// captured at import. setupTests ends each round with one real timer turn, so
// a real timer already queued runs before the round's check. Without that, a
// round gave it a turn only when a millisecond had passed, and a BYO page
// took 1 to 14 of the default 20 rounds to enable its install button.
const realSetTimeout: typeof setTimeout = jest.requireActual('timers').setTimeout;

test('each fake-timer waitFor round runs a real timer queued before it', async () => {
  jest.useFakeTimers();
  try {
    let checks = 0;
    let ran = false;
    // The overall timeout is fake time too and fires inside the round that
    // reaches it, before that round's check: 100 ms is exactly one checked round.
    await waitFor(() => {
      checks += 1;
      if (checks === 1) realSetTimeout(() => { ran = true; }, 0);
      expect(ran).toBe(true);
    }, { timeout: 100 });
    expect(checks).toBe(2);
  } finally {
    jest.useRealTimers();
  }
});
