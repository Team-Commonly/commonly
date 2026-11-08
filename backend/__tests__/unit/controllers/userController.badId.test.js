// F330: "me" (or any non-ObjectId) reaching the /api/users/:id handlers.
// GET /api/users/me has no route of its own, so it lands on /:id. getUserById
// already answered 404 but logged the CastError as an error on every call;
// follow, unfollow and public-activity let it become a 500. All four answer
// 404 "User not found", the answer for an id that matches no user, and log
// nothing. Real models, no database: Mongoose casts the id first.
const userController = require('../../../controllers/userController');

const resMock = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  res.send = jest.fn(() => res);
  return res;
};

describe('userController with a non-ObjectId :id', () => {
  let errorSpy;
  beforeEach(() => { errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => errorSpy.mockRestore());

  test.each([
    ['getUserById'],
    ['getUserPublicActivity'],
    ['followUser'],
    ['unfollowUser'],
  ])('%s answers 404 for "me" and logs nothing', async (handler) => {
    const req = {
      params: { id: 'me' },
      body: {},
      user: { id: '6a0000000000000000000001' },
      userId: '6a0000000000000000000001',
    };
    const res = resMock();
    await userController[handler](req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
