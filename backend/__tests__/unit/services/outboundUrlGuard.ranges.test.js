// Special-purpose ranges the classifier's tables did not list, and the 6to4
// and Teredo forms of IPv6. Before the 2026-10-26 table update these all
// classified as `public`, except the edges that stay public.
const dns = require('dns');
const http = require('http');
const https = require('https');

const {
  classifyAddress,
  postToPublicAddress,
  isOutboundUrlRefused,
} = require('../../../services/outboundUrlGuard');

describe('classifyAddress: documentation, benchmarking and IETF blocks', () => {
  test.each([
    '192.0.0.1', '192.0.0.255', // IETF protocol assignments
    '192.0.2.1', '198.51.100.1', '203.0.113.1', // documentation
    '198.18.0.1', '198.19.255.255', // benchmarking
    '2001:db8::1', // IPv6 documentation
    '2001:2::1', // IPv6 benchmarking
    '::ffff:192.0.2.1', '::ffff:198.18.0.1', '64:ff9b::c000:201', // the same blocks in IPv6 spellings
  ])('%s is reserved', (address) => {
    expect(classifyAddress(address)).toBe('reserved');
  });

  test.each([
    // the edges just outside each new block stay public
    '191.255.255.255', '192.0.1.0', '192.0.3.0', '198.17.255.255', '198.20.0.0',
    '198.51.99.255', '198.51.101.0', '203.0.112.255', '203.0.114.0',
  ])('%s is public', (address) => {
    expect(classifyAddress(address)).toBe('public');
  });
});

describe('classifyAddress: 6to4 is classified by the IPv4 address it carries', () => {
  test.each([
    ['2002:7f00:1::', 'private'], // 127.0.0.1
    ['2002:a00:1::1', 'private'], // 10.0.0.1
    ['2002:c0a8:101::', 'private'], // 192.168.1.1
    ['2002:a9fe:a9fe::', 'reserved'], // 169.254.169.254
    ['2002:c000:201::', 'reserved'], // 192.0.2.1
    ['2002:808:808::1', 'public'], // 8.8.8.8
  ])('%s is %s', (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });
});

describe('classifyAddress: other IPv6 forms the in-house tables missed', () => {
  test.each([
    ['::ffff:0:7f00:1', 'private'], // IPv4-translated (RFC 6145) 127.0.0.1
    ['::ffff:0:a9fe:a9fe', 'reserved'], // IPv4-translated 169.254.169.254
    ['fec0::1', 'reserved'], // deprecated site-local
    ['100::1', 'reserved'], // discard-only
  ])('%s is %s', (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });
});

describe('classifyAddress: Teredo is refused', () => {
  test.each(['2001::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2'])('%s is reserved', (address) => {
    expect(classifyAddress(address)).toBe('reserved');
  });
});

describe('postToPublicAddress refuses the new ranges end to end', () => {
  beforeEach(() => {
    delete process.env.OUTBOUND_WEBHOOK_ALLOW_PRIVATE_ADDRESSES;
    const noNetwork = () => { throw new Error('no network in refusal tests'); };
    jest.spyOn(http, 'request').mockImplementation(noNetwork);
    jest.spyOn(https, 'request').mockImplementation(noNetwork);
  });

  test.each([['198.18.0.1'], ['203.0.113.7'], ['2002:a9fe:a9fe::'], ['2001::1']])(
    'a name resolving to %s is refused without connecting',
    async (address) => {
      jest.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }]);

      const error = await postToPublicAddress('https://hooks.example.test/in', { headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(
        () => { throw new Error('expected a refusal'); },
        (e) => e,
      );

      expect(isOutboundUrlRefused(error)).toBe(true);
      expect(error.message).toBe(`outbound URL refused: host hooks.example.test resolves to ${address}, which is not allowed`);
      expect(http.request).not.toHaveBeenCalled();
      expect(https.request).not.toHaveBeenCalled();
    },
  );
});
