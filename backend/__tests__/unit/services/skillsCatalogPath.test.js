const fs = require('fs');
const path = require('path');
const {
  backendRootFrom,
  BUNDLED_CATALOG_PATH,
  resolveSkillsCatalogPath,
} = require('../../../services/skillsCatalogPath');

const BACKEND_ROOT = path.resolve(__dirname, '../../..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');

describe('skillsCatalogPath', () => {
  let savedPath;
  let savedDir;

  beforeEach(() => {
    savedPath = process.env.SKILLS_CATALOG_PATH;
    savedDir = process.env.SKILLS_CATALOG_DIR;
    delete process.env.SKILLS_CATALOG_PATH;
    delete process.env.SKILLS_CATALOG_DIR;
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.SKILLS_CATALOG_PATH;
    else process.env.SKILLS_CATALOG_PATH = savedPath;
    if (savedDir === undefined) delete process.env.SKILLS_CATALOG_DIR;
    else process.env.SKILLS_CATALOG_DIR = savedDir;
  });

  it('resolves the backend root from both the source and the built layout', () => {
    expect(backendRootFrom('/repo/backend/services')).toBe('/repo/backend');
    expect(backendRootFrom('/app/dist/services')).toBe('/app');
  });

  it('defaults to the one checked-in copy under backend/docs/skills', () => {
    expect(BUNDLED_CATALOG_PATH).toBe(
      path.join(BACKEND_ROOT, 'docs', 'skills', 'awesome-agent-skills-index.json'),
    );
    expect(resolveSkillsCatalogPath()).toBe(BUNDLED_CATALOG_PATH);
    expect(fs.existsSync(BUNDLED_CATALOG_PATH)).toBe(true);
  });

  it('keeps a single copy of the catalog in the repo', () => {
    // The root and Helm copies were deleted in TASK-029. Nothing reads them,
    // so a reappearance would be drift, not a fallback.
    expect(fs.existsSync(path.join(REPO_ROOT, 'docs/skills/awesome-agent-skills-index.json'))).toBe(false);
    expect(
      fs.existsSync(path.join(REPO_ROOT, 'k8s/helm/commonly/configs/awesome-agent-skills-index.json')),
    ).toBe(false);
  });

  it('prefers SKILLS_CATALOG_PATH, then SKILLS_CATALOG_DIR', () => {
    process.env.SKILLS_CATALOG_DIR = '/catalog-dir';
    expect(resolveSkillsCatalogPath()).toBe('/catalog-dir/awesome-agent-skills-index.json');
    process.env.SKILLS_CATALOG_PATH = '/explicit/index.json';
    expect(resolveSkillsCatalogPath()).toBe('/explicit/index.json');
  });
});
