const { isInstanceAccessRestricted, isInstanceEmailAllowed } = require('../../../services/instanceAccessPolicy');

afterEach(() => {
  delete process.env.AUTH_ALLOWED_EMAILS;
  delete process.env.AUTH_ALLOWED_DOMAINS;
});

it('leaves public instances unchanged when both lists are unset', () => {
  expect(isInstanceAccessRestricted()).toBe(false);
  expect(isInstanceEmailAllowed('anyone@example.com')).toBe(true);
});

it('matches complete addresses and exact domains without case sensitivity', () => {
  process.env.AUTH_ALLOWED_EMAILS = ' Person@Example.com ';
  process.env.AUTH_ALLOWED_DOMAINS = ' @Team.Example, second.example ';
  expect(isInstanceEmailAllowed('person@example.com')).toBe(true);
  expect(isInstanceEmailAllowed('OTHER@TEAM.EXAMPLE')).toBe(true);
  expect(isInstanceEmailAllowed('other@sub.team.example')).toBe(false);
  expect(isInstanceEmailAllowed('person@example.com.evil')).toBe(false);
  expect(isInstanceEmailAllowed('person@example.com@evil')).toBe(false);
});
