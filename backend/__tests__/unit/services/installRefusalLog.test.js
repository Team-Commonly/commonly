const { logInstallRefusal } = require('../../../services/installRefusalLog');

describe('logInstallRefusal', () => {
  it('writes one line of ids and counts', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    logInstallRefusal('registry.install', 'hosted_cap_reached', {
      userId: { toString: () => 'user-1' }, agentName: 'scout', instanceId: 'default', podId: 'pod-1', used: 1, cap: 1,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const [line] = warn.mock.calls[0];
    expect(line.startsWith('[install-refused] ')).toBe(true);
    expect(JSON.parse(line.slice('[install-refused] '.length))).toEqual({
      code: 'hosted_cap_reached',
      route: 'registry.install',
      userId: 'user-1',
      agentName: 'scout',
      instanceId: 'default',
      podId: 'pod-1',
      used: 1,
      cap: 1,
    });
  });

  it('never throws, so a refusal stays a 403', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const circular = {};
    circular.self = circular;
    expect(() => logInstallRefusal('hosted.provision', 'hosted_cap_reached', {
      userId: Object.create(null), agentName: circular, used: BigInt(1),
    })).not.toThrow();
    expect(warn).toHaveBeenCalledWith('[install-refused] {"code":"hosted_cap_reached","route":"hosted.provision"}');
  });

  it('keeps a typed agent name on one line', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    logInstallRefusal('personas.hire', 'cloud_agents_not_entitled', { userId: 'u', agentName: 'a\n[install-refused] forged' });
    expect(warn.mock.calls[0][0].split('\n')).toHaveLength(1);
  });
});
