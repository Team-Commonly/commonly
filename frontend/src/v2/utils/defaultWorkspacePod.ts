// The names and descriptions signup stores, one per locale. They must match
// backend/config/defaultWorkspacePod.ts (the test reads that file).
export const DEFAULT_WORKSPACE_POD_NAMES = ['My Workspace', '我的工作空间'];
export const DEFAULT_WORKSPACE_POD_DESCRIPTIONS = ['Your private workspace', '你的私人工作空间'];

export const isDefaultWorkspaceName = (name: string | undefined | null): boolean => (
  DEFAULT_WORKSPACE_POD_NAMES.includes(name || '')
);

export const isDefaultWorkspaceDescription = (description: string | undefined | null): boolean => (
  DEFAULT_WORKSPACE_POD_DESCRIPTIONS.includes(description || '')
);
