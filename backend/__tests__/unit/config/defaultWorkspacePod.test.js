const {
  defaultWorkspacePodFor,
  isDefaultWorkspaceName,
} = require('../../../config/defaultWorkspacePod');

describe('default workspace pod', () => {
  test('anything but zh-CN gets the English pod', () => {
    expect(defaultWorkspacePodFor('zh-CN').name).toBe('我的工作空间');
    expect(defaultWorkspacePodFor('en').name).toBe('My Workspace');
    expect(defaultWorkspacePodFor('fr').name).toBe('My Workspace');
    expect(defaultWorkspacePodFor(undefined).name).toBe('My Workspace');
  });

  test('recognises the name in every locale, and only those', () => {
    expect(isDefaultWorkspaceName('My Workspace')).toBe(true);
    expect(isDefaultWorkspaceName('我的工作空间')).toBe(true);
    expect(isDefaultWorkspaceName('Launch')).toBe(false);
    expect(isDefaultWorkspaceName(undefined)).toBe(false);
  });
});
