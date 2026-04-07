interface ValidationErrorDetail {
  field: string;
  message: string;
}

interface AgentManifest {
  name?: string;
  version?: string;
  description?: string;
  homepage?: string;
  scopes?: string[];
  categories?: string[];
  tags?: string[];
  memory?: string;
  [key: string]: unknown;
}

interface NormalizePublishPayloadResult {
  manifest: AgentManifest;
  displayName: string;
  readme: string;
  categories: string[];
  tags: string[];
}

class ManifestValidationError extends Error {
  details: ValidationErrorDetail[];

  constructor(details: ValidationErrorDetail[]) {
    super('Invalid agent manifest');
    this.name = 'ManifestValidationError';
    this.details = details;
  }
}

// Types re-exported from the JS module — implementations stay in .js

declare function normalizePublishPayload(payload: unknown): NormalizePublishPayloadResult;

module.exports = {
  ManifestValidationError,
  normalizePublishPayload: require('./agentManifestRegistry').normalizePublishPayload as typeof normalizePublishPayload,
};

export type { ManifestValidationError, ValidationErrorDetail, AgentManifest, NormalizePublishPayloadResult };
