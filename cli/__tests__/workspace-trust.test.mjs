/**
 * The predicates a `workspace`-trust seat stands on (TASK-294): which pods
 * count as private, and which start directories may be exposed to them.
 */
import {
  afterAll, describe, expect, test,
} from '@jest/globals';
import {
  mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  allPodsConfirmedPrivate,
  firstRunWorkspace,
  podIsConfirmedPrivate,
  workspaceStartDirRefusal,
} from '../src/lib/workspace-trust.js';

describe('pod visibility', () => {
  test('a pod is private only when both fields say so', () => {
    expect(podIsConfirmedPrivate({ publicRead: false, communityListed: false })).toBe(true);
    expect(podIsConfirmedPrivate({ publicRead: true, communityListed: false })).toBe(false);
    expect(podIsConfirmedPrivate({ publicRead: false, communityListed: true })).toBe(false);
  });

  test('an unreported field counts as public, so an older server fails closed', () => {
    expect(podIsConfirmedPrivate({ publicRead: false })).toBe(false);
    expect(podIsConfirmedPrivate({})).toBe(false);
    expect(podIsConfirmedPrivate(null)).toBe(false);
  });

  test('every pod must be private, and an empty list is not proof of anything', () => {
    const priv = { publicRead: false, communityListed: false };
    expect(allPodsConfirmedPrivate([priv, priv])).toBe(true);
    expect(allPodsConfirmedPrivate([priv, { publicRead: true, communityListed: false }])).toBe(false);
    expect(allPodsConfirmedPrivate([])).toBe(false);
    expect(allPodsConfirmedPrivate(undefined)).toBe(false);
  });
});

describe('workspace start directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'commonly-ws-trust-'));
  const home = join(root, 'home');
  const repo = join(home, 'code', 'repo');
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(home, '.commonly', 'tokens'), { recursive: true });
  const linkToHome = join(root, 'link-to-home');
  symlinkSync(home, linkToHome);

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test('a project directory under $HOME is accepted', () => {
    expect(workspaceStartDirRefusal(repo, { home })).toBeNull();
  });

  test('/, $HOME and an ancestor of $HOME are refused', () => {
    expect(workspaceStartDirRefusal('/', { home })).toBe('the start directory is /');
    expect(workspaceStartDirRefusal(home, { home })).toBe('the start directory is your home directory');
    expect(workspaceStartDirRefusal(root, { home })).toBe('the start directory contains your home directory');
  });

  test('a symlink to $HOME is refused as $HOME', () => {
    expect(workspaceStartDirRefusal(linkToHome, { home }))
      .toBe('the start directory is your home directory');
  });

  test('a directory inside a credential store is refused', () => {
    expect(workspaceStartDirRefusal(join(home, '.commonly', 'tokens'), { home }))
      .toBe('the start directory is inside ~/.commonly');
  });

  test('a relative path is refused', () => {
    expect(workspaceStartDirRefusal('code/repo', { home }))
      .toBe('the start directory is not an absolute path');
  });
});

describe('first-run workspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'commonly-ws-first-run-'));
  const home = join(root, 'home');
  const repo = join(home, 'code', 'repo');
  mkdirSync(repo, { recursive: true });
  const priv = { publicRead: false, communityListed: false };
  const pub = { publicRead: true, communityListed: false };

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test('a claude seat whose pods are all private reads the project it started in', () => {
    expect(firstRunWorkspace({
      adapterName: 'claude', installations: [priv, priv], startDir: repo, home,
    })).toEqual({ workspacePath: realpathSync(repo), reason: null });
  });

  test('one public pod keeps the public default, and moving the start dir would not help', () => {
    const result = firstRunWorkspace({
      adapterName: 'claude', installations: [priv, pub], startDir: repo, home,
    });
    expect(result.workspacePath).toBeNull();
    expect(result.reason).toMatch(/publicly readable/);
    expect(result).not.toHaveProperty('fix');
  });

  test('a refused start directory keeps the public default and says where to start instead', () => {
    expect(firstRunWorkspace({
      adapterName: 'claude', installations: [priv], startDir: home, home,
    })).toEqual({
      workspacePath: null,
      reason: 'the start directory is your home directory',
      fix: expect.stringMatching(/project's folder/),
    });
  });

  test('every other adapter has nothing to decide, since workspace is claude-only', () => {
    ['codex', 'opencode', 'qwen', 'pi', 'goose', 'dsh'].forEach((adapterName) => {
      expect(firstRunWorkspace({
        adapterName, installations: [priv], startDir: repo, home,
      })).toBeNull();
    });
  });
});
