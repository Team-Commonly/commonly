// The rest of IANA's special-purpose registries beyond outboundUrlGuard.ranges,
// the fail-closed default for unassigned IPv6, and the decoding of IPv6 forms
// that carry an IPv4 address.
const { classifyAddress } = require('../../../services/outboundUrlGuard');

describe('classifyAddress: remaining registry rows', () => {
  test.each([
    '192.88.99.1', // deprecated 6to4 relay anycast
    '64:ff9b:1::a00:1', // local-use translation
    '100:0:0:1::1', // dummy prefix
    '2001:10::1', '2001:1ff::1', // inside IETF protocol assignments
    '3fff::1', // documentation
    '5f00::1', // segment routing
  ])('%s is reserved', (address) => {
    expect(classifyAddress(address)).toBe('reserved');
  });

  test.each([
    '192.88.98.255', '192.88.100.0', // edges of 192.88.99.0/24
    '192.31.196.1', '192.52.193.1', '192.175.48.1', // AS112, AMT: globally reachable
    '2620:4f:8000::1', // AS112-v6: globally reachable
    '2001:200::1', '2001:db7::1', '2001:db9::1', '3fff:1000::1', // edges of the IPv6 blocks
  ])('%s stays public', (address) => {
    expect(classifyAddress(address)).toBe('public');
  });
});

describe('classifyAddress: IPv6 outside global unicast is refused unless a table names it', () => {
  test.each(['1::1', '4000::1', 'c000::1', 'fe00::1'])('%s is reserved', (address) => {
    expect(classifyAddress(address)).toBe('reserved');
  });
});

describe('classifyAddress: IPv6 forms that carry an IPv4 address use that address', () => {
  test.each([
    // Teredo: server 65.54.227.120, client bits inverted
    ['2001:0:4136:e378:8000:63bf:80ff:fffe', 'private'], // 127.0.0.1
    ['2001:0:4136:e378:8000:63bf:f5ff:fffe', 'private'], // 10.0.0.1
    ['2001:0:4136:e378:8000:63bf:5601:5601', 'reserved'], // 169.254.169.254
    ['2001:0:4136:e378:8000:63bf:f7f7:f7f7', 'public'], // 8.8.8.8
    ['::ffff:0:808:808', 'public'], // IPv4-translated, 8.8.8.8
  ])('%s is %s', (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });
});
