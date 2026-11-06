// supertest's request(app) calls app.listen(0), which binds a port on `::`, then
// connects to 127.0.0.1. On macOS that wildcard bind can land on a port another
// process holds on 127.0.0.1, and the specific listener wins the connection, so
// a test reads a stranger's 401, 404 or 503. Calling ::1 reaches the socket
// supertest bound. Only macOS changes: this has only been seen there, and a
// container can have no ::1 at all.
const loopbackUrl = (url, family, platform = process.platform) => {
  if (platform !== 'darwin' || family !== 'IPv6') return url;
  return url.replace('://127.0.0.1:', '://[::1]:');
};

const installSupertestLoopback = () => {
  // eslint-disable-next-line global-require
  const Test = require('supertest/lib/test');
  const { serverAddress } = Test.prototype;
  Test.prototype.serverAddress = function serverAddressOnBoundSocket(app, path) {
    const url = serverAddress.call(this, app, path);
    return loopbackUrl(url, app.address().family);
  };
};

module.exports = { loopbackUrl, installSupertestLoopback };
