import getApiBaseUrl, { getApiAliasUrl } from './apiBaseUrl';

// The same-origin build (2026-10): the shell's API base is its own host, and the alias keeps
// the calls that must stay on the API's own host there.
describe('getApiAliasUrl', () => {
  const saved = { base: process.env.REACT_APP_API_URL, alias: process.env.REACT_APP_API_ALIAS_URL };
  afterEach(() => {
    if (saved.base === undefined) delete process.env.REACT_APP_API_URL; else process.env.REACT_APP_API_URL = saved.base;
    if (saved.alias === undefined) delete process.env.REACT_APP_API_ALIAS_URL; else process.env.REACT_APP_API_ALIAS_URL = saved.alias;
  });

  test('names the API host, not the shell host, in a same-origin build', () => {
    process.env.REACT_APP_API_URL = 'https://commonly.me';
    process.env.REACT_APP_API_ALIAS_URL = 'https://api.commonly.me';
    expect(getApiBaseUrl()).toBe('https://commonly.me');
    expect(getApiAliasUrl()).toBe('https://api.commonly.me');
  });

  test('falls back to the API base when no alias is set, so other builds are unchanged', () => {
    process.env.REACT_APP_API_URL = 'https://api.example.test';
    delete process.env.REACT_APP_API_ALIAS_URL;
    expect(getApiAliasUrl()).toBe('https://api.example.test');
  });
});
