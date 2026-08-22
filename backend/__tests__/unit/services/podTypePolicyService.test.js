const {
  PERSONAL_POD_TYPES,
  isPersonalPodType,
} = require('../../../services/podTypePolicyService');

describe('podTypePolicyService', () => {
  it.each(['agent-admin', 'agent-room', 'agent-dm'])(
    'marks %s as a personal conversation type',
    (type) => {
      expect(isPersonalPodType(type)).toBe(true);
      expect(PERSONAL_POD_TYPES.has(type)).toBe(true);
    },
  );

  it.each(['chat', 'study', 'games', 'agent-ensemble', 'team'])(
    'does not treat %s as personal',
    (type) => {
      expect(isPersonalPodType(type)).toBe(false);
    },
  );
});
