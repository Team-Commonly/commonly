// The rest of IANA's special-purpose registries beyond outboundUrlGuard.ranges,
// the fail-closed default for unassigned IPv6, and Teredo whatever its embedded
// client address.
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
    '2620:4f:8000::1', '2001:4:112::1', // AS112-v6: globally reachable
    '2001:3::1', '2001:30::1', // AMT, drone remote ID entity tags: globally reachable
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

describe('classifyAddress: Teredo is refused whatever client it carries', () => {
  // server 65.54.227.120; the client address is stored with every bit inverted
  test.each([
    '2001:0:4136:e378:8000:63bf:80ff:fffe', // 127.0.0.1
    '2001:0:4136:e378:8000:63bf:f5ff:fffe', // 10.0.0.1
    '2001:0:4136:e378:8000:63bf:f7f7:f7f7', // 8.8.8.8
  ])('%s is reserved', (address) => {
    expect(classifyAddress(address)).toBe('reserved');
  });
});

describe('classifyAddress: IPv4-translated addresses use the IPv4 address they carry', () => {
  test('::ffff:0:808:808 (8.8.8.8) is public', () => {
    expect(classifyAddress('::ffff:0:808:808')).toBe('public');
  });
});
