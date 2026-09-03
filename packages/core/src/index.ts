/**
 * @commonly/core — the client core every Commonly app shares.
 *
 * Rule for this package: no React, no DOM, no process.env, no singletons.
 * Everything is constructed from a Session, so the web app, the desktop
 * shell, and mobile each own their storage and their lifetime.
 */
import { Api } from './api';
import { Auth } from './auth';
import { Connectors } from './connectors';
import { Pods } from './pods';
import { Session, type TokenStore } from './session';
import { Live } from './socket';

export { Api, ApiError } from './api';
export { Auth } from './auth';
export type { User, LoginResult, RegisterInput, OAuthProvider } from './auth';
export { Connectors } from './connectors';
export type { Integration, ConnectorType } from './connectors';
export { Pods } from './pods';
export type { Pod, Message } from './pods';
export { Session, memoryTokenStore, webTokenStore } from './session';
export type { TokenStore, SessionConfig } from './session';
export { Live } from './socket';
export type { LiveEvent } from './socket';

export interface Client {
  session: Session;
  api: Api;
  auth: Auth;
  pods: Pods;
  connectors: Connectors;
  live: Live;
}

/** One call wires the whole core for an app. */
export const createClient = (baseUrl: string, store: TokenStore): Client => {
  const session = new Session({ baseUrl, store });
  const api = new Api(session);
  return {
    session,
    api,
    auth: new Auth(api, session),
    pods: new Pods(api),
    connectors: new Connectors(api),
    live: new Live(session),
  };
};
