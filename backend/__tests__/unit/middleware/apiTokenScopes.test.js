const { requireApiTokenScopes } = require('../../../middleware/apiTokenScopes');

describe('requireApiTokenScopes middleware', () => {
  const createRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  };

  it('skips scope checks for non-api-token auth', () => {
    const req = {
      authType: 'user',
      apiTokenScopes: [],
    };
    const res = createRes();
    const next = jest.fn();

    requireApiTokenScopes(['agent:messages:write'])(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('allows api tokens with no declared scopes', () => {
    const req = {
      authType: 'apiToken',
    };
    const res = createRes();
    const next = jest.fn();

    requireApiTokenScopes(['agent:messages:write'])(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('allows api tokens that include every required scope', () => {
    const req = {
      authType: 'apiToken',
      apiTokenScopes: ['agent:messages:write', 'agent:context:read'],
    };
    const res = createRes();
    const next = jest.fn();

    requireApiTokenScopes(['agent:messages:write'])(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects api tokens that are missing required scopes', () => {
    const req = {
      authType: 'apiToken',
      apiTokenScopes: ['agent:context:read'],
    };
    const res = createRes();
    const next = jest.fn();

    requireApiTokenScopes(['agent:messages:write', 'agent:events:ack'])(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      message: 'API token missing required permissions',
      missing: ['agent:messages:write', 'agent:events:ack'],
    });
  });
});
