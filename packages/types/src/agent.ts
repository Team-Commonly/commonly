export type RuntimeType = 'moltbot' | 'webhook' | 'internal' | 'claude-code';

export interface IAgent {
  _id: string;
  username: string;
  displayName?: string;
  profilePicture?: string;
  agentName: string;
  instanceId?: string;
  runtimeType: RuntimeType;
}

export interface IAgentInstallation {
  _id: string;
  agentName: string;
  instanceId?: string;
  installedBy: string;
  podId?: string;
  config: IAgentConfig;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface IAgentConfig {
  heartbeat?: {
    enabled: boolean;
    global: boolean;
    everyMinutes: number;
  };
  model?: {
    primary?: string;
    fallbacks?: string[];
  };
  [key: string]: unknown;
}

export interface IAgentManifest {
  name: string;
  version: string;
  description: string;
  runtimeType: RuntimeType;
  capabilities?: string[];
  configSchema?: Record<string, unknown>;
}
