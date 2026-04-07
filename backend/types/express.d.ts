import { Types } from 'mongoose';
import { IAgentInstallationRegistry } from '../models/AgentRegistry';
import { IAppInstallation } from '../models/AppInstallation';
import { IUser } from '../models/User';

declare global {
  namespace Express {
    interface Request {
      // Set by auth.js
      userId?: string;
      user?: { id: string; username?: string; email?: string; role?: string };
      authType?: 'jwt' | 'apiToken';
      apiTokenScopes?: string[];
      apiTokenCreatedAt?: Date | null;

      // Set by agentRuntimeAuth.js
      agentUser?: IUser;
      agentInstallation?: IAgentInstallationRegistry | null;
      agentInstallations?: IAgentInstallationRegistry[];
      agentAuthorizedPodIds?: string[];

      // Set by appAuth.js
      appInstallation?: IAppInstallation;
    }
  }
}

export {};
