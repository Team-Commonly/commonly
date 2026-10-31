import path from 'path';

// The one checked-in copy of the skills catalog lives at
// backend/docs/skills/, the only location inside the backend Docker build
// context. The image bakes it at /app/docs/skills/, and the Helm init
// container copies it from there when SKILLS_CATALOG_URL is unset or fails.

const CATALOG_FILE = 'awesome-agent-skills-index.json';

// This module runs from backend/services/ under ts-node and jest, and from
// backend/dist/services/ in the built image. Either way the answer is the
// backend package root.
export const backendRootFrom = (dir: string): string => {
  const parent = path.resolve(dir, '..');
  return path.basename(parent) === 'dist' ? path.resolve(parent, '..') : parent;
};

export const BUNDLED_CATALOG_PATH = path.join(
  backendRootFrom(__dirname),
  'docs',
  'skills',
  CATALOG_FILE,
);

// SKILLS_CATALOG_PATH wins, then SKILLS_CATALOG_DIR, then the bundled copy.
// Every reader and the refresh writer go through here so they agree.
export const resolveSkillsCatalogPath = (): string => {
  if (process.env.SKILLS_CATALOG_PATH) {
    return process.env.SKILLS_CATALOG_PATH;
  }
  if (process.env.SKILLS_CATALOG_DIR) {
    return path.join(process.env.SKILLS_CATALOG_DIR, CATALOG_FILE);
  }
  return BUNDLED_CATALOG_PATH;
};
