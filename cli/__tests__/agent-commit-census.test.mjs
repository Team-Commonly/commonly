import {
  execFileSync as execFileSyncWithEnv,
  spawnSync as spawnSyncWithEnv,
} from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const censusScript = fileURLToPath(new URL('../../scripts/agent-commit-census', import.meta.url));
const fixtureEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
  !name.startsWith('GIT_CONFIG_') && !name.startsWith('COMMONLY_AGENT_')
)));
const execFileSync = (command, args, options = {}) => execFileSyncWithEnv(command, args, {
  env: fixtureEnv,
  ...options,
});
const spawnSync = (command, args, options = {}) => spawnSyncWithEnv(command, args, {
  env: fixtureEnv,
  ...options,
});

describe('agent-commit-census', () => {
  test('counts parsed and body-carried Commonly co-authors and reads model lines', () => {
    const root = mkdtempSync(join(tmpdir(), 'commonly-agent-census-'));
    const messageFile = join(root, 'message.txt');
    const seatTrailer = 'Co-authored-by: Seat One <WyJzZWF0LW9uZSIsImRlZmF1bHQiXQ@agents.commonly.invalid>';
    try {
      execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 'Fixture Author'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: root });

      const commits = [
        {
          file: 'single.txt',
          subject: 'single-commit squash (#1)',
          body: [
            'Agent-Model: codex/model-one/high',
            '',
            '---------',
            '',
            seatTrailer,
          ].join('\n'),
        },
        {
          file: 'multi.txt',
          subject: 'multi-commit squash (#2)',
          body: [
            '* first branch commit',
            '',
            seatTrailer,
            'Agent-Model: claude/model-two/medium',
            '',
            '* second branch commit',
            '',
            seatTrailer,
            'Agent-Model: codex/model-three/high',
            '',
            '---------',
            '',
            seatTrailer,
          ].join('\n'),
        },
        {
          file: 'unlifted.txt',
          subject: 'multi-commit squash without lifted co-author (#3)',
          body: [
            '* source commit',
            '',
            seatTrailer,
            '',
            'source commit body continues after the co-author line',
            '',
            'Agent-Model: codex/model-four/high',
          ].join('\n'),
        },
      ];

      const commitIds = [];
      for (const commit of commits) {
        writeFileSync(join(root, commit.file), `${commit.subject}\n`);
        execFileSync('git', ['add', commit.file], { cwd: root });
        writeFileSync(messageFile, `${commit.subject}\n\n${commit.body}\n`);
        execFileSync('git', ['commit', '-F', messageFile], { cwd: root });
        commitIds.push(execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: root,
          encoding: 'utf8',
        }).trim());
      }

      const parsedCoAuthors = execFileSync('git', [
        'log', '-1', '--format=%(trailers:key=Co-authored-by)', commitIds[0],
      ], { cwd: root, encoding: 'utf8' }).trim();
      expect(parsedCoAuthors).toBe(seatTrailer);

      const unliftedParsedCoAuthors = execFileSync('git', [
        'log', '-1', '--format=%(trailers:key=Co-authored-by)', commitIds[2],
      ], { cwd: root, encoding: 'utf8' }).trim();
      expect(unliftedParsedCoAuthors).toBe('');

      const result = spawnSync(process.execPath, [censusScript, 'main'], {
        cwd: root,
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('3\tWyJzZWF0LW9uZSIsImRlZmF1bHQiXQ\tSeat One');
      expect(result.stdout).toContain('1\t1\tcodex/model-one/high');
      expect(result.stdout).toContain('1\t1\tclaude/model-two/medium');
      expect(result.stdout).toContain('1\t1\tcodex/model-three/high');
      expect(result.stdout).toContain('1\t1\tcodex/model-four/high');
      expect(result.stderr).toContain('no parsed seat trailer; counting 1 seat(s) from message-body lines');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails loudly when model lines have neither a parsed seat nor a body seat line', () => {
    const root = mkdtempSync(join(tmpdir(), 'commonly-agent-census-unattributed-'));
    const messageFile = join(root, 'message.txt');
    try {
      execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 'Fixture Author'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: root });
      writeFileSync(join(root, 'file'), 'fixture\n');
      execFileSync('git', ['add', 'file'], { cwd: root });
      writeFileSync(messageFile, 'unattributed commit\n\nAgent-Model: codex/model/high\n');
      execFileSync('git', ['commit', '-F', messageFile], { cwd: root });

      const result = spawnSync(process.execPath, [censusScript, 'main'], {
        cwd: root,
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('possible co-author lift failure');
      expect(result.stderr).toContain('no parsed seat trailer or Commonly seat line in the body');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('streams commit history larger than the child-process buffer', () => {
    const root = mkdtempSync(join(tmpdir(), 'commonly-agent-census-large-'));
    const messageFile = join(root, 'message.txt');
    const seatTrailer = 'Co-authored-by: Seat Large <WyJzZWF0LWxhcmdlIiwiZGVmYXVsdCJd@agents.commonly.invalid>';
    try {
      execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 'Fixture Author'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: root });
      writeFileSync(join(root, 'file'), 'fixture\n');
      execFileSync('git', ['add', 'file'], { cwd: root });
      writeFileSync(messageFile, [
        'large-history fixture',
        '',
        'Agent-Model: codex/model-large/high',
        '',
        'x'.repeat(1024 * 1024 + 64),
        '',
        seatTrailer,
        '',
      ].join('\n'));
      execFileSync('git', ['commit', '-F', messageFile], { cwd: root });

      const result = spawnSync(process.execPath, [censusScript, 'main'], {
        cwd: root,
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('1\tWyJzZWF0LWxhcmdlIiwiZGVmYXVsdCJd\tSeat Large');
      expect(result.stdout).toContain('1\t1\tcodex/model-large/high');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
