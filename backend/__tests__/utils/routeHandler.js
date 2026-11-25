// Shared by the F626 5xx-body tests: call a route's final handler directly, and
// capture status/body plus what the server logged.
const DRIVER_TEXT = 'connect ECONNREFUSED db.internal.example:5432 relation "secret_table" does not exist';
const LEAKS = ['db.internal.example', 'secret_table', 'ECONNREFUSED'];

const getRouteHandler = (router, path, method) => {
  const layer = router.stack.find((entry) => (
    entry.route && entry.route.path === path && entry.route.methods[method]
  ));
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};

const makeRes = () => {
  const out = { status: 200, body: undefined };
  const res = {
    status: (n) => { out.status = n; return res; },
    json: (d) => { out.body = d; return res; },
    send: (d) => { out.body = d; return res; },
  };
  return { res, out };
};

const expectNoLeak = (out) => {
  const body = JSON.stringify(out.body);
  LEAKS.forEach((leak) => expect(body).not.toContain(leak));
};

module.exports = { DRIVER_TEXT, LEAKS, getRouteHandler, makeRes, expectNoLeak };
