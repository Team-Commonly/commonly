// TASK-503: chat messages become Postgres-only, so the one-command local
// install (./install.sh -> docker-compose.local.yml) must run Postgres. It ran
// MongoDB alone until this change, and removing the fallback would have broken
// every local self-host. These are presence checks on the files the installer
// actually reads; the boot itself is proven by running ./install.sh.
const fs = require('fs');
const path = require('path');

const read = (name) => fs.readFileSync(path.join(__dirname, '../../../../', name), 'utf8');
const compose = read('docker-compose.local.yml');
const serviceBlock = (name) => {
  const start = compose.search(new RegExp(`^  ${name}:\\s*$`, 'm'));
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = compose.slice(start + 1);
  const next = rest.search(/^ {2}[a-z][\w-]*:\s*$|^[a-z][\w-]*:\s*$/m);
  return next === -1 ? rest : rest.slice(0, next);
};

describe('local compose runs Postgres for chat', () => {
  it('declares a Postgres service pinned to a major version, with a health check and a volume', () => {
    const pg = serviceBlock('postgres');
    expect(pg).toMatch(/image: postgres:\d+(-alpine)?\s*$/m);
    expect(pg).toMatch(/pg_isready/);
    expect(pg).toMatch(/postgres-data:\/var\/lib\/postgresql\/data/);
    expect(compose).toMatch(/^volumes:[\s\S]*^ {2}postgres-data:/m);
    // Not published to the host: only the app ports are.
    expect(pg).not.toMatch(/ports:/);
  });

  it('starts the backend after Postgres is healthy and hands it the PG_* settings', () => {
    const backend = serviceBlock('backend');
    expect(backend).toMatch(/postgres:\s*\n\s*condition: service_healthy/);
    ['PG_HOST=postgres', 'PG_PORT=5432', 'PG_USER=', 'PG_PASSWORD=${PG_PASSWORD:?', 'PG_DATABASE=', 'PG_SSL_ENABLED=false']
      .forEach((setting) => expect(backend).toContain(setting));
  });

  it.each(['install.sh', 'scripts/demo-bootstrap.sh'])('%s writes a PG_PASSWORD into .env when one is missing', (name) => {
    const script = read(name);
    expect(script).toMatch(/grep -Eq '\^PG_PASSWORD=\.\+\$'/);
    expect(script).toMatch(/PG_PASSWORD=%s/);
  });
});
