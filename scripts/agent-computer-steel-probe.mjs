// Runs inside the Steel container, as the container's own user, started by
// scripts/agent-computer-steel-probe.sh. It attacks the browser the way a
// hostile page would and counts what reaches loopback.
//
// A witness server on 127.0.0.1:3999 records every request and WebSocket
// upgrade that arrives. "Blocked" means the witness saw nothing, not that the
// page saw an error. It answers like a permissive service (any origin, private
// network allowed), so nothing on the server side hides a reach.
//
// PROBE_MODE=enforce fails on any reach the chart's Chrome policy should stop.
// PROBE_MODE=report records the same attacks against the image's own policy,
// the control showing the probe can see a reach at all.
import fs from 'node:fs';
import http from 'node:http';

const MODE = process.env.PROBE_MODE || 'enforce';
const PAGE = process.env.PROBE_PAGE; // the attacking page, e.g. http://page.probe.test:8080/
const LOOP_NAME = process.env.PROBE_LOOP_NAME; // a name that resolves to 127.0.0.1
const CDP = 'http://127.0.0.1:9222';
const STEEL = 'http://127.0.0.1:3001';
const W = 'http://127.0.0.1:3999';
const WN = `http://${LOOP_NAME}:3999`;
const BLOCKED = 'net::ERR_BLOCKED_BY_ADMINISTRATOR';

if (!PAGE || !LOOP_NAME) throw new Error('PROBE_PAGE and PROBE_LOOP_NAME are required');

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const withTimeout = (promise, ms, value) => Promise.race([promise, sleep(ms).then(() => value)]);

const hits = [];
const witness = http.createServer((req, res) => {
  hits.push(req.url);
  res.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Allow-Headers': '*',
    'Content-Type': 'text/plain',
  });
  res.end('witness');
});
witness.on('upgrade', (req, socket) => { hits.push(req.url); socket.destroy(); });
await new Promise((resolve) => { witness.listen(3999, '127.0.0.1', resolve); });
const reached = (tag) => hits.some((url) => url.startsWith(`/${tag}`));

class Cdp {
  constructor(url) {
    this.url = url;
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('CDP socket error'));
      this.ws.onmessage = (message) => {
        const msg = JSON.parse(message.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: done, reject: fail } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) fail(new Error(msg.error.message));
          else done(msg.result);
        } else if (msg.method) {
          this.events.push(msg);
        }
      };
    });
  }

  send(method, params = {}, ms = 15000) {
    this.nextId += 1;
    const id = this.nextId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, ms);
    });
  }

  async waitForEvent(method, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (this.events.some((event) => event.method === method)) return true;
      await sleep(100);
    }
    return false;
  }
}

const until = async (what, ms, fn) => {
  const end = Date.now() + ms;
  let last = null;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      last = err;
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
};

const version = await until('Chrome DevTools', 90000, async () => (await fetch(`${CDP}/json/version`)).json());
const target = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
const cdp = new Cdp(target.webSocketDebuggerUrl);
await cdp.open();
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');

const evaluate = async (expression, ms = 12000) => {
  try {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, ms);
    if (r.exceptionDetails) return `exception ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`;
    return r.result.value;
  } catch (err) {
    return `error ${err.message}`;
  }
};

const navigate = async (url) => {
  cdp.events.length = 0;
  try {
    const r = await cdp.send('Page.navigate', { url }, 12000);
    if (r.errorText) return r.errorText;
    await cdp.waitForEvent('Page.loadEventFired', 10000);
    return 'loaded';
  } catch (err) {
    return `error ${err.message}`;
  }
};

const results = [];
// kind: assert (the chart's policy must stop it), residual (the policy is not
// expected to stop it; the runbook names it), control (must succeed).
const record = (test, kind, isReached, detail) => results.push({ test, kind, reached: isReached, detail });

const loadPage = async () => {
  const outcome = await navigate(PAGE);
  const title = await evaluate('document.title');
  if (title !== 'probe') throw new Error(`the attacking page did not load: ${outcome} / ${title}`);
};

// 1. Navigations the browser is told to make, as a CDP client would. In
// production the broker's allowlist decides these first; the policy is the
// floor under it.
const cdpNavigations = [
  ['cdp-nav-loopback-ip', `${W}/cdp-nav-loopback-ip`, true],
  ['cdp-nav-localhost', 'http://localhost:3999/cdp-nav-localhost', true],
  ['cdp-nav-any-address', 'http://0.0.0.0:3999/cdp-nav-any-address', true],
  ['cdp-nav-ipv6-loopback', 'http://[::1]:3999/cdp-nav-ipv6-loopback', false],
  ['cdp-nav-metadata-ip', 'http://169.254.169.254/computeMetadata/v1/', false],
  ['cdp-nav-metadata-name', 'http://metadata.google.internal/computeMetadata/v1/', false],
  ['cdp-nav-cluster-name', 'http://kubernetes.default.svc.cluster.local/', false],
  ['cdp-nav-file', 'file:///etc/passwd', false],
  ['cdp-nav-redirect-hop', `${PAGE}redir?to=${encodeURIComponent(`${W}/cdp-nav-redirect-hop`)}`, true],
];
for (const [test, url, witnessed] of cdpNavigations) {
  const outcome = await navigate(url);
  // A witnessed target counts what arrived; the others count only a policy refusal.
  record(test, 'assert', witnessed ? reached(test) : outcome !== BLOCKED, outcome);
}
const rebindNav = await navigate(`${WN}/cdp-nav-rebind-name`);
record('cdp-nav-rebind-name', 'residual', reached('cdp-nav-rebind-name'), rebindNav);

// 2. Requests a page makes on its own, the path no broker guard sees when the
// broker isn't connected, and the one a socket or worker takes even when it is.
await loadPage();
const sameOrigin = await evaluate(`fetch(${JSON.stringify(`${PAGE}ok.txt`)}).then((r) => r.text(), (e) => 'refused ' + e.message)`);
record('page-fetch-same-origin', 'control', sameOrigin === 'ok', sameOrigin);

const pageFetch = (url, mode) => `Promise.race([
  fetch(${JSON.stringify(url)}, { mode: ${JSON.stringify(mode)} }).then((r) => 'answered ' + r.type + ' ' + r.status, (e) => 'refused ' + e.message),
  new Promise((resolve) => setTimeout(() => resolve('timeout'), 8000)),
])`;
const pageSocket = (url) => `new Promise((resolve) => {
  const ws = new WebSocket(${JSON.stringify(url)});
  ws.onopen = () => { resolve('open'); ws.close(); };
  ws.onerror = () => resolve('error');
  setTimeout(() => resolve('timeout'), 8000);
})`;
const pageImage = (url) => `new Promise((resolve) => {
  const img = new Image();
  img.onload = () => resolve('load');
  img.onerror = () => resolve('error');
  img.src = ${JSON.stringify(url)};
  setTimeout(() => resolve('timeout'), 8000);
})`;
const inWorker = (body) => `new Promise((resolve) => {
  const code = 'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));' +
    'self.onmessage = async () => { let out; try { out = await (' + ${JSON.stringify(body)} + '); } catch (e) { out = "refused " + e.message; } postMessage(String(out)); };';
  const worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
  worker.onmessage = (m) => resolve(m.data);
  worker.onerror = (e) => resolve('worker error ' + e.message);
  worker.postMessage('go');
  setTimeout(() => resolve('timeout'), 9000);
})`;
const pageFrame = (url) => `new Promise((resolve) => {
  const frame = document.createElement('iframe');
  frame.onload = () => resolve('load');
  frame.src = ${JSON.stringify(url)};
  document.body.appendChild(frame);
  setTimeout(() => resolve('timeout'), 6000);
})`;

const pageAttacks = [
  ['page-fetch-loopback', pageFetch(`${W}/page-fetch-loopback`, 'no-cors')],
  ['page-fetch-loopback-cors', pageFetch(`${W}/page-fetch-loopback-cors`, 'cors')],
  ['page-fetch-rebind-name', pageFetch(`${WN}/page-fetch-rebind-name`, 'no-cors')],
  ['page-fetch-redirect-hop', pageFetch(`${PAGE}redir?to=${encodeURIComponent(`${W}/page-fetch-redirect-hop`)}`, 'no-cors')],
  ['page-image-loopback', pageImage(`${W}/page-image-loopback`)],
  ['page-socket-loopback', pageSocket('ws://127.0.0.1:3999/page-socket-loopback')],
  ['page-socket-rebind-name', pageSocket(`ws://${LOOP_NAME}:3999/page-socket-rebind-name`)],
  ['worker-fetch-loopback', inWorker(`fetch('${W}/worker-fetch-loopback', { mode: 'no-cors' }).then((r) => 'answered ' + r.type)`)],
  ['worker-socket-loopback', inWorker(`new Promise((resolve) => { const ws = new WebSocket('ws://127.0.0.1:3999/worker-socket-loopback'); ws.onopen = () => resolve('open'); ws.onerror = () => resolve('error'); setTimeout(() => resolve('timeout'), 6000); })`)],
  ['page-frame-loopback', pageFrame(`${W}/page-frame-loopback`)],
  ['page-frame-rebind-name', pageFrame(`${WN}/page-frame-rebind-name`)],
];
for (const [test, expression] of pageAttacks) {
  const outcome = await evaluate(expression);
  record(test, 'assert', reached(test), outcome);
}

// The real targets: Steel's API, which answers any origin, and Chrome's own
// DevTools socket, which accepts any origin.
const steelRead = await evaluate(pageFetch(`${STEEL}/v1/sessions`, 'cors'));
record('page-read-steel-api', 'assert', steelRead.startsWith('answered'), steelRead);
const devtoolsSocket = await evaluate(pageSocket(version.webSocketDebuggerUrl));
record('page-socket-devtools', 'assert', devtoolsSocket === 'open', devtoolsSocket);

// 3. The page moves its own main frame. A loopback name on the list is
// refused; a public name that resolves to loopback is the residual the
// runbook names.
for (const [test, url, kind] of [
  ['page-nav-loopback-ip', `${W}/page-nav-loopback-ip`, 'assert'],
  ['page-nav-rebind-name', `${WN}/page-nav-rebind-name`, 'residual'],
]) {
  await loadPage();
  await evaluate(`setTimeout(() => { location.href = ${JSON.stringify(url)}; }, 0); 'set'`);
  await sleep(4000);
  record(test, kind, reached(test), await evaluate('location.href', 4000));
}

// 4. Every browser process runs as this container's user, with no capabilities.
const processes = fs.readdirSync('/proc').filter((pid) => /^\d+$/.test(pid)).flatMap((pid) => {
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    if (!cmd.includes('chromium')) return [];
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    return [{ uid: status.match(/^Uid:\s+(\d+)/m)[1], capEff: status.match(/^CapEff:\s+(\S+)/m)[1] }];
  } catch {
    return [];
  }
});
const uid = String(process.getuid());
record('browser-processes-non-root', 'control',
  processes.length > 0 && processes.every((p) => p.uid === uid && uid !== '0' && /^0+$/.test(p.capEff)),
  `${processes.length} processes, uids ${[...new Set(processes.map((p) => p.uid))].join(',')}, CapEff ${[...new Set(processes.map((p) => p.capEff))].join(',')}`);

const failures = results.filter((r) => (r.kind === 'control' && !r.reached) || (MODE === 'enforce' && r.kind === 'assert' && r.reached));
console.log(JSON.stringify({ mode: MODE, browser: version.Browser, results, failures: failures.map((f) => f.test) }));
witness.close();
cdp.ws.close();
process.exit(failures.length ? 1 : 0);
