# Mongo pool stats (`[mongo-pool]`)

An opt-in log line, once a minute, that says whether backend queries wait for a free MongoDB pool connection (F636). Code: `backend/services/mongoPoolStats.ts`, wired in `backend/config/db.ts`.

## Why it exists

The backend has one MongoClient, created by `mongoose.connect` with no pool options. Mongoose 7.8 uses its nested `mongodb` driver 5.9, whose defaults are **maxPoolSize 100** and **maxIdleTimeMS 0 (idle connections are never closed)**. So a socket count at ~100 only tells you peak concurrency once reached 100. It doesn't tell you checkouts are waiting now. This line does.

## Turn it on

1. Set `MONGO_POOL_STATS=1` in the backend's environment. Any other value, or no value, leaves it off, and nothing is registered.
2. Recreate the backend container or pod so it picks up the new environment. A plain restart doesn't re-read an env file.
3. Look for `[mongo-pool] pool stats on` after `MongoDB connected`, then one `[mongo-pool] checkouts=…` line per minute.

To turn it off, unset the variable and recreate the backend again.

## Fields

Example: `[mongo-pool] checkouts=20 waited=18 samples=20 waitMs p50=95 p95=193 max=195 maxCheckedOut=2 maxWaiting=20 waitingNow=0 failed=0 created=1 closed=0 open=1 servers=1 dropped=0`

Interval counters reset after each line:

| Field | Meaning |
|---|---|
| `checkouts` | Connections handed to an operation (`connectionCheckedOut`). |
| `waited` | Checkouts whose wait was 5 ms or more. |
| `samples` | Wait samples that `waited` and the percentiles are computed from: completed checkouts that found a start time. It can be below `checkouts`, because a checkout with no start time (one in flight when stats started, or one whose start was dropped) still counts in `checkouts`. |
| `waitMs p50 / p95 / max` | Checkout wait percentiles in ms (nearest rank), approximated as described below. `0` when there were no checkouts. |
| `maxCheckedOut` | Highest number of connections checked out at once during the interval. It starts from the number still held. |
| `maxWaiting` | Highest number of checkouts started but not yet served or failed. Every checkout raises it, even one served at once, so any interval with checkouts has `maxWaiting` of at least 1. It measures checkout concurrency, not waiting. |
| `failed` | `connectionCheckOutFailed` events. `failedReasons=timeout:N,…` follows the line only when any failed (`timeout`, `connectionError`, `poolClosed`). |
| `created` / `closed` | Connections opened and closed in the interval. |
| `dropped` | Start times dropped because an address's FIFO passed 10,000 entries. Anything above 0 means the wait numbers for that interval are unreliable. |

Running values carry across intervals:

| Field | Meaning |
|---|---|
| `open` | `created` minus `closed` since stats started. It can read low: connections opened before `MongoDB connected` aren't counted. It can also read high: if the pool clears while a connection is still being made, the driver destroys that connection without emitting `connectionClosed`. |
| `waitingNow` | Checkouts started and not yet served or failed at the moment of the line. A current gauge, not a peak. |
| `servers` | How many server addresses have had checkouts. The address itself is never logged, because it's a host. |

## The wait is an approximation

Driver 5.9 puts no duration on any CMAP event. Each event carries only `address`, `time` and, on most, `connectionId` or `reason`. So the stats keep a FIFO of `connectionCheckOutStarted` times for each address. A `connectionCheckedOut` or `connectionCheckOutFailed` on that address takes the oldest start time off the queue, and the difference is the wait.

`checkouts` is exact. `waited` and the percentiles are approximate whenever checkouts complete out of order:

- The pool creates up to 2 connections at once (`maxConnecting`), and they can finish out of order.
- A waiting checkout can be cancelled out of order.

When that happens, the recorded waits themselves change, not just which checkout they're attributed to. Say A starts at 0 ms and B at 100 ms, then B is checked out at 101 ms and A at 200 ms. The real waits are [1, 200], but the collector records [101, 100]. That moves `waited` and p95.

`maxCheckedOut`, `maxWaiting`, `failed` and `created` don't depend on the pairing, so they read reliably.

Two more sources of skew:

- The queue starts empty. An end event for a checkout already in flight when stats start counts a checkout with no wait sample, or pairs with a newer start. That skew, and any skew from cap drops, corrects itself once the queue empties.

The running counts are clamped at 0.

**The wait includes connect time.** When a checkout has to open a new connection, the TCP/TLS handshake counts as wait. So `waited` and p95 can rise while `maxCheckedOut` stays well under the pool size. That pattern points at slow new connections (the network, or a connection limit on the path), not saturation.

## Reading it

Always read the wait together with `maxCheckedOut` and `created`.

- **Pool saturation:** `maxCheckedOut` at or near the pool size (100 by default), `waited` above 0, and a p95 wait in the hundreds of ms. Queries are queueing for a connection. If `created` is also above 0, part of the wait is connect time. Look at what holds connections (long queries, cursors left open, bursts of parallel work) before raising maxPoolSize.
- **Slow new connections:** `waited` and p95 up, `created` above 0 and `maxCheckedOut` well under the pool size. Checkouts wait on connection setup, not on a free connection. See [mongo-new-connections-time-out.md](mongo-new-connections-time-out.md).
- **Probably not the pool:** `samples` close to `checkouts`; p95 and `waitMs max` near 0; `waitingNow` 0; `failed=0`; `created` near 0; and `maxCheckedOut` well under the pool size. Then the sampled checkouts didn't wait measurably (within the approximation above) and nothing was pending at the line, so look for the slowness elsewhere, such as the event loop (`[loop-lag]`, [cpu-profile-on-signal.md](cpu-profile-on-signal.md)), the network or the server. Every condition matters. p95 can hide one slow checkout, so check `max` too. `maxWaiting` is an interval peak that every checkout raises to at least 1, so it measures concurrency, not waiting, and doesn't belong in this test. The wait figures cover only sampled, completed checkouts (`samples`). A checkout still pending at the line shows in `waitingNow`, not in the wait figures. And percentiles of 0 with `samples=0` are no data, which prove nothing.
- **`checkouts=0`:** `waitingNow` above 0 means checkouts were pending at the line, for example on a connection setup that spans intervals. `failed` counts the checkouts that ended in failure during the interval.
- `failed` with `timeout` means a checkout waited past `waitQueueTimeoutMS`. With `connectionError`, connections can't be established at all (see [mongo-new-connections-time-out.md](mongo-new-connections-time-out.md)).
- `created` and `closed` both high in every interval means connections are churning. With maxIdleTimeMS 0 they should stay near 0 once the pool is warm.
