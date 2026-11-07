/**
 * The pod every signup starts in. Its name is stored, so it's in the language
 * the person signed up in, and every surface reads it without a lookup. An
 * account never switches: a name it already has stays, and its owner can
 * rename it. So "is this the default workspace" has to accept every locale's name.
 */
const DEFAULT_WORKSPACE_POD = {
  en: { name: 'My Workspace', description: 'Your private workspace' },
  'zh-CN': { name: '我的工作空间', description: '你的私人工作空间' },
} as const;

export const defaultWorkspacePodFor = (locale: unknown) => (
  DEFAULT_WORKSPACE_POD[locale === 'zh-CN' ? 'zh-CN' : 'en']
);

export const isDefaultWorkspaceName = (name: unknown): boolean => (
  Object.values(DEFAULT_WORKSPACE_POD).some((pod) => pod.name === name)
);
