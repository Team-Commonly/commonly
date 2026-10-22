/**
 * github.list_pull_request_files carries each file's diff, capped.
 *
 * It returned only names and line counts, so an agent reviewing a pull request
 * through the GitHub connector could not see the code it was asked to review.
 * Patches now ride along, at most PR_FILE_PATCH_MAX_BYTES per file and
 * PR_FILES_PATCH_TOTAL_MAX_BYTES per call, and every cut or omission says so.
 */
const mockGithub = { listPullRequestFiles: jest.fn() };
jest.mock('../../../services/githubAppService', () => mockGithub);

const {
  TOOL_DEFINITIONS,
  PR_FILE_PATCH_MAX_BYTES,
  PR_FILES_PATCH_TOTAL_MAX_BYTES,
} = require('../../../services/toolBrokerService');

const tool = TOOL_DEFINITIONS['github.list_pull_request_files'];
const connection = {
  type: 'github-app', owner: 'Team-Commonly', repo: 'demo-day', installationId: '1',
};
const bytes = (text) => Buffer.byteLength(text, 'utf8');
const file = (filename, patch, extra = {}) => ({
  filename, status: 'modified', additions: 1, deletions: 1, changes: 2, blob_url: `https://github.com/x/y/blob/h/${filename}`,
  ...(patch === undefined ? {} : { patch }),
  ...extra,
});
// A hunk of `lines` lines, each `width` characters plus its newline.
const hunk = (lines, width = 79) => Array.from({ length: lines }, (_, i) => `+${String(i).padEnd(width - 1, 'x')}\n`).join('');

const run = async (files) => {
  mockGithub.listPullRequestFiles.mockResolvedValueOnce(files);
  return tool.call({ pullNumber: 4 }, connection);
};

describe('github.list_pull_request_files returns capped patches', () => {
  test('the caps are 8 KB per file and 32 KB in total, and the tool says so', () => {
    expect(PR_FILE_PATCH_MAX_BYTES).toBe(8 * 1024);
    expect(PR_FILES_PATCH_TOTAL_MAX_BYTES).toBe(32 * 1024);
    expect(tool.description).toMatch(/8 KB per file and 32 KB in total/);
    expect(tool.requiredWriteMode).toBe('read');
  });

  test('a small patch comes back whole, beside the fields the tool already returned', async () => {
    const patch = '@@ -1,3 +1,3 @@\n-  return new Date(placedAt).toISOString().slice(0, 10);\n+  return localDay(placedAt);\n';
    const { files } = await run([file('src/orderDate.js', patch)]);
    expect(files).toEqual([{
      filename: 'src/orderDate.js', status: 'modified', additions: 1, deletions: 1, changes: 2,
      url: 'https://github.com/x/y/blob/h/src/orderDate.js', patch,
    }]);
    expect(mockGithub.listPullRequestFiles).toHaveBeenCalledWith(expect.objectContaining({
      owner: 'Team-Commonly', repo: 'demo-day', pullNumber: 4, forceApp: true,
    }));
  });

  test('a file GitHub gives no patch for says so instead of looking empty', async () => {
    const { files } = await run([file('logo.png', undefined, { status: 'added' })]);
    expect(files[0]).toMatchObject({ filename: 'logo.png', patch: null, patchOmitted: 'not_provided_by_github' });
  });

  test('a patch over the per-file cap is cut at a whole line and marked', async () => {
    const original = hunk(200); // 16,000 bytes
    const { files } = await run([file('src/big.js', original)]);
    const [{ patch, patchTruncated }] = files;
    expect(patchTruncated).toBe(true);
    expect(bytes(patch)).toBeLessThanOrEqual(PR_FILE_PATCH_MAX_BYTES);
    expect(bytes(patch)).toBeGreaterThan(PR_FILE_PATCH_MAX_BYTES - 80);
    expect(patch.endsWith('\n')).toBe(true);
    expect(original.startsWith(patch)).toBe(true);
  });

  test('the total cap holds across files, and files past it are named, not dropped', async () => {
    const each = hunk(100); // 8,000 bytes: under the per-file cap
    const { files } = await run(['a', 'b', 'c', 'd', 'e', 'f'].map((name) => file(`src/${name}.js`, each)));
    expect(files).toHaveLength(6);
    const total = files.reduce((sum, f) => sum + (typeof f.patch === 'string' ? bytes(f.patch) : 0), 0);
    expect(total).toBeLessThanOrEqual(PR_FILES_PATCH_TOTAL_MAX_BYTES);
    expect(files.slice(0, 4).every((f) => f.patch === each && !f.patchTruncated)).toBe(true);
    expect(files[4]).toMatchObject({ patchTruncated: true });
    expect(bytes(files[4].patch)).toBeLessThanOrEqual(PR_FILES_PATCH_TOTAL_MAX_BYTES - 4 * 8000);
    expect(files[5]).toMatchObject({ filename: 'src/f.js', patch: null, patchOmitted: 'total_cap' });
  });

  test('a cut never splits a multi-byte character', async () => {
    const original = `+${'订单'.repeat(2000)}`; // one line, 12,001 bytes
    const { files } = await run([file('src/i18n.js', original)]);
    const [{ patch }] = files;
    expect(bytes(patch)).toBeLessThanOrEqual(PR_FILE_PATCH_MAX_BYTES);
    expect(patch).not.toContain('�');
    expect(Buffer.from(patch, 'utf8').toString('utf8')).toBe(patch);
    expect(original.startsWith(patch)).toBe(true);
  });
});
