/* eslint-disable global-require, import/no-unresolved, import/extensions */
const mockPodFind = jest.fn();
const mockGrantFind = jest.fn();
const mockConnectionFind = jest.fn();

jest.mock('../../../models/Pod', () => ({
  __esModule: true,
  default: { find: (...args) => mockPodFind(...args) },
}));
jest.mock('../../../models/RoomGrant', () => ({
  __esModule: true,
  default: { find: (...args) => mockGrantFind(...args) },
}));
jest.mock('../../../models/Integration', () => ({
  __esModule: true,
  default: { find: (...args) => mockConnectionFind(...args) },
}));

const { podHasOutsiderWritableGrant, podsWithOutsiderWritableGrants } = require('../../../services/nativeOutsiderGrantPolicy');

const POD = '507f1f77bcf86cd799439011';
const SEAT = '507f1f77bcf86cd799439013';
const OTHER = '507f1f77bcf86cd799439014';
const CONNECTION = '507f1f77bcf86cd799439015';
const ELSEWHERE = '507f1f77bcf86cd799439016';
const chain = (rows) => ({ select: () => ({ lean: async () => rows }) });
const grant = (overrides = {}) => ({
  connectionId: CONNECTION,
  target: { kind: 'pod', id: POD },
  audience: [SEAT],
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockPodFind.mockReturnValue(chain([{ _id: POD, members: [SEAT] }]));
  mockGrantFind.mockReturnValue(chain([grant()]));
  mockConnectionFind.mockReturnValue(chain([{ _id: CONNECTION, type: 'hosted-mcp' }]));
});

test('a live pod grant with a current audience member narrows every native agent in the pod', async () => {
  expect(await podHasOutsiderWritableGrant(POD)).toBe(true);
  expect(mockGrantFind).toHaveBeenCalledWith(expect.objectContaining({
    revokedAt: null,
    expiresAt: { $gt: expect.any(Date) },
    $or: expect.arrayContaining([
      { 'target.kind': 'pod', 'target.id': { $in: [POD] } },
      { 'target.kind': 'seat', 'target.id': { $in: [SEAT] } },
    ]),
  }));
  expect(mockConnectionFind).toHaveBeenCalledWith(expect.objectContaining({
    type: { $in: ['hosted-mcp', 'github-app'] },
    $or: expect.arrayContaining([{ _id: { $in: [CONNECTION] } }]),
  }));
});

test('a GitHub App grant may name an installation id rather than a Mongo id', async () => {
  mockGrantFind.mockReturnValue(chain([grant({ connectionId: 'github-installation-123' })]));
  mockConnectionFind.mockReturnValue(chain([{ _id: CONNECTION, type: 'github-app', installationId: 'github-installation-123' }]));
  expect(await podHasOutsiderWritableGrant(POD)).toBe(true);
  expect(mockConnectionFind).toHaveBeenCalledWith(expect.objectContaining({
    $or: [{ type: 'github-app', installationId: { $in: ['github-installation-123'] } }],
  }));
});

test('batch census checks multiple installation pods with one query per collection', async () => {
  mockPodFind.mockReturnValue(chain([{ _id: POD, members: [SEAT] }, { _id: OTHER, members: [SEAT] }]));
  mockGrantFind.mockReturnValue(chain([grant({ target: { kind: 'pod', id: OTHER } })]));
  expect(await podsWithOutsiderWritableGrants([POD, OTHER])).toEqual(new Set([OTHER]));
  expect(mockPodFind).toHaveBeenCalledTimes(1);
  expect(mockGrantFind).toHaveBeenCalledTimes(1);
  expect(mockConnectionFind).toHaveBeenCalledTimes(1);
});

test('a seat-targeted grant narrows every requested pod containing the seat, and no other', async () => {
  mockPodFind.mockReturnValue(chain([
    { _id: POD, members: [SEAT] }, { _id: OTHER, members: [SEAT] }, { _id: ELSEWHERE, members: [OTHER] },
  ]));
  mockGrantFind.mockReturnValue(chain([grant({ target: { kind: 'seat', id: SEAT }, audience: [SEAT] })]));
  expect(await podsWithOutsiderWritableGrants([POD, OTHER, ELSEWHERE])).toEqual(new Set([POD, OTHER]));
});

test('a seat-targeted grant whose audience omits the seat narrows nothing', async () => {
  mockPodFind.mockReturnValue(chain([{ _id: POD, members: [SEAT] }]));
  mockGrantFind.mockReturnValue(chain([grant({ target: { kind: 'seat', id: SEAT }, audience: [] })]));
  expect(await podsWithOutsiderWritableGrants([POD])).toEqual(new Set());
});

test('a seat grant is in scope only when its seat is a current member and in its audience', async () => {
  mockGrantFind.mockReturnValue(chain([grant({ target: { kind: 'seat', id: SEAT } })]));
  expect(await podHasOutsiderWritableGrant(POD)).toBe(true);

  mockGrantFind.mockReturnValue(chain([grant({ target: { kind: 'seat', id: OTHER }, audience: [OTHER] })]));
  expect(await podHasOutsiderWritableGrant(POD)).toBe(false);
  mockGrantFind.mockReturnValue(chain([grant({ target: { kind: 'seat', id: SEAT }, audience: [OTHER] })]));
  expect(await podHasOutsiderWritableGrant(POD)).toBe(false);
});

test('a pod grant without any current audience member does not narrow this pod', async () => {
  mockGrantFind.mockReturnValue(chain([grant({ audience: [OTHER] })]));
  expect(await podHasOutsiderWritableGrant(POD)).toBe(false);
  expect(mockConnectionFind).not.toHaveBeenCalled();
});

test('revocation or expiry lifts narrowing, and an absent connection does too', async () => {
  mockGrantFind.mockReturnValue(chain([]));
  expect(await podHasOutsiderWritableGrant(POD)).toBe(false);
  mockGrantFind.mockReturnValue(chain([grant()]));
  mockConnectionFind.mockReturnValue(chain([]));
  expect(await podHasOutsiderWritableGrant(POD)).toBe(false);
});
