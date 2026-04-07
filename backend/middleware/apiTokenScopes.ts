import { Request, Response, NextFunction } from 'express';

export function requireApiTokenScopes(requiredScopes: string[] = []) {
  return (req: Request, res: Response, next: NextFunction): void | Response => {
    if (req.authType !== 'apiToken') return next();

    const scopes = Array.isArray(req.apiTokenScopes) ? req.apiTokenScopes : [];
    if (scopes.length === 0) return next();

    const missing = requiredScopes.filter((scope) => !scopes.includes(scope));
    if (missing.length > 0) {
      return res.status(403).json({
        message: 'API token missing required permissions',
        missing,
      });
    }

    return next();
  };
}
