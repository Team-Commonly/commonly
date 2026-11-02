import { getV2EquivalentPath } from '../legacyV2Path';

describe('getV2EquivalentPath', () => {
  test('/login keeps its query, so ?next= and a provider error survive the move into v2', () => {
    expect(getV2EquivalentPath('/login', '?next=%2Fv2%2Fagents%2Fbyo')).toBe('/v2/login?next=%2Fv2%2Fagents%2Fbyo');
    expect(getV2EquivalentPath('/login', '?oauthError=invitation_required')).toBe('/v2/login?oauthError=invitation_required');
    expect(getV2EquivalentPath('/login', '')).toBe('/v2/login');
  });

  test('sign-up paths keep theirs, as before', () => {
    expect(getV2EquivalentPath('/register', '?invite=abc')).toBe('/v2/register?invite=abc');
    expect(getV2EquivalentPath('/register/invite-required', '')).toBe('/v2/register/invite-required');
  });

  test('public pages are not app paths', () => {
    expect(getV2EquivalentPath('/', '')).toBeNull();
    expect(getV2EquivalentPath('/guides', '')).toBeNull();
  });
});
