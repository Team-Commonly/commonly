// F512 (CodeRabbit #4135): the join time is taken before the authorization
// wait, so a join abandoned during that wait must stamp nothing, or a mention
// reads as seen by someone who never had the pod open.
const { joinPodRoom, leavePodRoom } = require('../../../services/socketPodVisits');

const fakeSocket = () => ({
  userId: 'u1',
  connected: true,
  data: { joinedPods: new Set(), pendingJoins: new Set() },
  join: jest.fn(),
  leave: jest.fn(),
});
const fakeStamps = () => ({ stampPodOpened: jest.fn().mockResolvedValue(undefined), stampPodClosed: jest.fn().mockResolvedValue(undefined) });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

describe('joinPodRoom', () => {
  it('joins, records and stamps the open with the time taken before authorization', async () => {
    const socket = fakeSocket();
    const stamps = fakeStamps();
    const before = Date.now();
    let authorizedAt = 0;
    // Authorization takes a while; the stamp must not move to after it.
    const pod = await joinPodRoom(socket, 'p1', async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      authorizedAt = Date.now();
      return { id: 'p1' };
    }, stamps);
    expect(pod).toEqual({ id: 'p1' });
    expect(stamps.stampPodOpened.mock.calls[0][2].getTime()).toBeLessThan(authorizedAt);
    expect(socket.join).toHaveBeenCalledWith('pod_p1');
    expect(socket.data.joinedPods.has('p1')).toBe(true);
    expect(socket.data.pendingJoins.size).toBe(0);
    const [, podId, at] = stamps.stampPodOpened.mock.calls[0];
    expect(podId).toBe('p1');
    expect(at.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('stamps nothing when the socket disconnects during authorization', async () => {
    const socket = fakeSocket();
    const stamps = fakeStamps();
    const auth = deferred();
    const joining = joinPodRoom(socket, 'p1', () => auth.promise, stamps);
    socket.connected = false;
    auth.resolve({ id: 'p1' });
    expect(await joining).toBeNull();
    expect(stamps.stampPodOpened).not.toHaveBeenCalled();
    expect(socket.join).not.toHaveBeenCalled();
    expect(socket.data.joinedPods.size).toBe(0);
  });

  it('stamps only the close when the pod is left during authorization, and never joins after it', async () => {
    const socket = fakeSocket();
    const stamps = fakeStamps();
    const auth = deferred();
    const joining = joinPodRoom(socket, 'p1', () => auth.promise, stamps);
    expect(leavePodRoom(socket, 'p1', stamps)).toBe(true);
    auth.resolve({ id: 'p1' });
    expect(await joining).toBeNull();
    expect(stamps.stampPodClosed).toHaveBeenCalledWith('u1', ['p1']);
    expect(stamps.stampPodOpened).not.toHaveBeenCalled();
    expect(socket.join).not.toHaveBeenCalled();
    expect(socket.data.joinedPods.size).toBe(0);
  });

  it('a refused join stamps nothing and leaves no pending entry', async () => {
    const socket = fakeSocket();
    const stamps = fakeStamps();
    expect(await joinPodRoom(socket, 'p1', async () => null, stamps)).toBeNull();
    expect(stamps.stampPodOpened).not.toHaveBeenCalled();
    expect(socket.data.pendingJoins.size).toBe(0);
  });

  it('a throwing authorization leaves no pending entry', async () => {
    const socket = fakeSocket();
    await expect(joinPodRoom(socket, 'p1', async () => { throw new Error('db'); }, fakeStamps())).rejects.toThrow('db');
    expect(socket.data.pendingJoins.size).toBe(0);
  });
});

describe('leavePodRoom', () => {
  it('stamps a close only for a pod this socket had open', () => {
    const socket = fakeSocket();
    const stamps = fakeStamps();
    expect(leavePodRoom(socket, 'never-joined', stamps)).toBe(false);
    expect(stamps.stampPodClosed).not.toHaveBeenCalled();
    socket.data.joinedPods.add('p1');
    expect(leavePodRoom(socket, 'p1', stamps)).toBe(true);
    expect(stamps.stampPodClosed).toHaveBeenCalledWith('u1', ['p1']);
    expect(socket.data.joinedPods.has('p1')).toBe(false);
  });
});
