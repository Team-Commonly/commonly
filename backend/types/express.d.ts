import { Types } from 'mongoose';
import { IAgentInstallationRegistry } from '../models/AgentRegistry';
import { IAgentCredential } from '../models/AgentCredential';
import { IAppInstallation } from '../models/AppInstallation';
import { IUser } from '../models/User';

declare global {
  namespace Express {
    interface Request {
      // Set by auth.js
      userId?: string;
      user?: { id: string; username?: string; email?: string; role?: string };
      authType?: 'jwt' | 'apiToken' | 'deviceToken';
      apiTokenScopes?: string[];
      apiTokenCreatedAt?: Date | null;

      // Set by agentRuntimeAuth.js
      agentUser?: IUser;
      // TASK-094: the per-token rate-limit bucket (agentRateLimit.ts reads
      // this; before it was set nothing keyed the limiter per token) and the
      // credential row behind the bearer.
      agentTokenHash?: string;
      agentCredential?: IAgentCredential | null;
      agentInstallation?: IAgentInstallationRegistry | null;
      agentInstallations?: IAgentInstallationRegistry[];
      agentAuthorizedPodIds?: string[];

      // Set by appAuth.js
      appInstallation?: IAppInstallation;
    }
  }
}

export {};
