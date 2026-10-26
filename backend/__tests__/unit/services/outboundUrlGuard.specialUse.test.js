// The special-purpose ranges from IANA's IPv4 and IPv6 registries, and the
// IPv6 forms that carry an IPv4 address. Each address below classified as
// `public` before these rows were added, except where a test says it stays.
const dns = require('dns');
const http = require('http');
const https = require('https');

const {
  classifyAddress,
  postToPublicAddress,
  isOutboundUrlRefused,
} = require('../../../services/outboundUrlGuard');

describe('classifyAddress: IPv4 special-purpose blocks', () => {
  test.each([
    '192.0.0.1', '192.0.0.255', // IETF protocol assignments
    '192.0.2.1', '198.51.100.1', '203.0.113.1', // documentation
    '198.18.0.1', '198.19.255.255', // benchmarking
    '192.88.99.1', // deprecated 6to4 relay anycast
  ])('%s is reserved', (address) => {
    expect(classifyAddress(address)).toBe('reserved');
  });

  test.each([
    // the edges just outside each block
    '191.255.255.255', '192.0.1.0', '192.0.3.0', '198.17.255.255', '198.20.0.0',
    '198.51.99.255', '198.51.101.0', '203.0.112.255', '203.0.114.0', '192.88.98.255', '192.88.100.0',
    // globally reachable registry rows
    '192.31.196.1', '192.52.193.1', '192.175.48.1',
  ])('%s stays public', (address) => {
    expect(classifyAddress(address)).toBe('public');
  });

  test.each(['::ffff:192.0.2.1', '::ffff:198.18.0.1', '64:ff9b::c000:201'])(
    'the same blocks in IPv6 spelling: %s is reserved',
    (address) => {
      expect(classifyAddress(address)).toBe('reserved');
    },
  );
});

describe('classifyAddress: IPv6 special-purpose blocks', () => {
  test.each([
    '64:ff9b:1::a00:1', // local-use translation
    '100::1', '100:0:0:1::1', // discard-only, dummy prefix
    '2001:2::1', '2001:10::1', '2001:1ff::1', // inside IETF protocol assignments
    '2001:db8::1', '3fff::1', // documentation
    '5f00::1', // segment routing
    'fec0::1', // deprecated site-local
  ])('%s is reserved', (address) => {
    expect(classifyAddress(address)).toBe('reserved');
  });

  test.each(['2001:200::1', '2001:db7::1', '2001:db9::1', '3fff:1000::1', '2620:4f:8000::1'])(
    '%s stays public',
    (address) => {
      expect(classifyAddress(address)).toBe('public');
    },
  );
});

describe('classifyAddress: IPv6 forms that carry an IPv4 address use that address', () => {
  test.each([
    ['2002:7f00:1::', 'private'], // 6to4, 127.0.0.1
    ['2002:a00:1::1', 'private'], // 6to4, 10.0.0.1
    ['2002:a9fe:a9fe::', 'reserved'], // 6to4, 169.254.169.254
    ['2002:c000:201::', 'reserved'], // 6to4, 192.0.2.1
    ['2002:808:808::1', 'public'], // 6to4, 8.8.8.8
    // Teredo: server 65.54.227.120, client bits inverted
    ['2001:0:4136:e378:8000:63bf:80ff:fffe', 'private'], // 127.0.0.1
    ['2001:0:4136:e378:8000:63bf:f5ff:fffe', 'private'], // 10.0.0.1
    ['2001:0:4136:e378:8000:63bf:5601:5601', 'reserved'], // 169.254.169.254
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'reserved'], // 192.0.2.45, RFC 4380's example
    ['2001:0:4136:e378:8000:63bf:f7f7:f7f7', 'public'], // 8.8.8.8
    ['::ffff:0:7f00:1', 'private'], // IPv4-translated, 127.0.0.1
    ['::ffff:0:a9fe:a9fe', 'reserved'], // IPv4-translated, 169.254.169.254
    ['::ffff:0:808:808', 'public'], // IPv4-translated, 8.8.8.8
  ])('%s is %s', (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });
});

describe('postToPublicAddress refuses the added ranges end to end', () => {
  beforeEach(() => {
    delete process.env.OUTBOUND_WEBHOOK_ALLOW_PRIVATE_ADDRESSES;
    const noNetwork = () => { throw new Error('no network in refusal tests'); };
    jest.spyOn(http, 'request').mockImplementation(noNetwork);
    jest.spyOn(https, 'request').mockImplementation(noNetwork);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each([
    ['198.18.0.1'],
    ['203.0.113.7'],
    ['2002:a9fe:a9fe::'],
    ['2001:0:4136:e378:8000:63bf:5601:5601'],
  ])('a name resolving to %s is refused without connecting', async (address) => {
    jest.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }]);

    const error = await postToPublicAddress('https://hooks.example.test/in', {
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).then(
      () => { throw new Error('expected a refusal'); },
      (e) => e,
    );

    expect(isOutboundUrlRefused(error)).toBe(true);
    expect(error.message)
      .toBe(`outbound URL refused: host hooks.example.test resolves to ${address}, which is not allowed`);
    expect(http.request).not.toHaveBeenCalled();
    expect(https.request).not.toHaveBeenCalled();
  });
});
