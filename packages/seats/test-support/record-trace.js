/**
 * A ctx.trace backed by a real record-v1 store, so adapter tests run under the
 * strict writer: an entry the record would refuse throws here exactly as it
 * would in production. `events` keeps what the adapter emitted, in order.
 */
import { randomUUID } from 'node:crypto';
import { createTraceStore } from '../src/trace/store.js';

export const recordTrace = ({ root, secrets = [], actor = { type: 'agent', id: 'agent-test', owner: 'user-owner' } }) => {
  const store = createTraceStore({ root });
  const runId = `run-${randomUUID().slice(0, 12)}`;
  const run = store.startRun({ runId, adapter: 'acp-test', actor });
  run.redact(secrets);
  const events = [];
  return {
    events,
    run,
    store,
    lines: () => store.readRun(runId),
    verify: () => store.verifyRun(runId),
    trace: {
      emit(type, data) {
        const entry = run.emit(type, data);
        events.push({ type, data });
        return entry;
      },
    },
  };
};
