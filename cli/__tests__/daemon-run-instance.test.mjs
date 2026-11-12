// F459: `daemon run --instance` was "unknown option" though login and register
// take it. Run serves this computer's one registration, so the flag confirms
// it: the registered instance runs, any other is refused with the register line.
import { describe, expect, test } from '@jest/globals';
import { daemonRunInstanceRefusal } from '../src/commands/daemon.js';

const record = { instanceUrl: 'https://api.example.test' };
const resolveFrom = (saved) => (identifier) => {
  if (/^https?:\/\//.test(identifier)) return { key: null, url: identifier.replace(/\/$/, '') };
  return saved[identifier] ? { key: identifier, url: saved[identifier] } : null;
};
const resolve = resolveFrom({ prod: 'https://api.example.test/', other: 'https://other.example.test' });

describe('daemonRunInstanceRefusal', () => {
  test('no flag, or the registered instance by URL or saved key, runs', () => {
    expect(daemonRunInstanceRefusal(record, undefined, resolve)).toBeNull();
    expect(daemonRunInstanceRefusal(record, 'https://API.example.test/', resolve)).toBeNull();
    expect(daemonRunInstanceRefusal(record, 'prod', resolve)).toBeNull();
  });

  test('another instance is refused, naming the registration and the register line', () => {
    const refusal = daemonRunInstanceRefusal(record, 'other', resolve);
    expect(refusal).toMatch(/registered with https:\/\/api\.example\.test, not other\./);
    expect(refusal).toMatch(/daemon register --instance other$/);
  });

  test('an unknown saved key is refused, not quietly run against the registration', () => {
    const refusal = daemonRunInstanceRefusal(record, 'nope', resolve);
    expect(refusal).toMatch(/no saved instance is named nope/);
    expect(refusal).toMatch(/login --instance <url>\), then .*daemon register --instance <url>$/);
    expect(refusal).not.toMatch(/register --instance nope/);
  });
});
