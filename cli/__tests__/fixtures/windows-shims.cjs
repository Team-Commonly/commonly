// .cjs, not .mjs: jest runs every .mjs under __tests__ as a suite.
//
// Real npm cmd-shim `.cmd` output, for the Windows launch tests (#2141).
//
// The current shapes were produced by running cmd-shim 8.0.0 (bundled with
// npm 11; lib/index.js `writeShim_`) on a JS bin, a JS bin whose shebang
// carries a flag, an .exe bin, and a /bin/sh bin, then substituting the
// relative target. Only the target path differs from that output. The legacy
// shape is cmd-shim <= 3.x (npm 6 and older), which used `%~dp0` directly and
// an `@IF EXIST … ( … ) ELSE ( … )` block.

const head = '@ECHO off\r\n'
  + 'GOTO start\r\n'
  + ':find_dp0\r\n'
  + 'SET dp0=%~dp0\r\n'
  + 'EXIT /b\r\n'
  + ':start\r\n'
  + 'SETLOCAL\r\n'
  + 'CALL :find_dp0\r\n';

// cmd-shim >= 4 for `#!/usr/bin/env node [flags]`; `target` is relative to
// the shim's folder, with backslashes.
const currentJsShim = (target, flags = '') => `${head}\r\n`
  + 'IF EXIST "%dp0%\\node.exe" (\r\n'
  + '  SET "_prog=%dp0%\\node.exe"\r\n'
  + ') ELSE (\r\n'
  + '  SET "_prog=node"\r\n'
  + '  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n'
  + ')\r\n'
  + '\r\n'
  + 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & '
  + `"%_prog%" ${flags} "%dp0%\\${target}" %*\r\n`;

// cmd-shim >= 4 for a bin with no shebang (a native .exe).
const currentExeShim = (target) => `${head}"%dp0%\\${target}"   %*\r\n`;

// cmd-shim >= 4 for `#!/bin/sh`: the program is not node.
const currentShShim = (target) => `${head}\r\n`
  + 'IF EXIST "%dp0%\\/bin/sh.exe" (\r\n'
  + '  SET "_prog=%dp0%\\/bin/sh.exe"\r\n'
  + ') ELSE (\r\n'
  + '  SET "_prog=/bin/sh"\r\n'
  + '  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n'
  + ')\r\n'
  + '\r\n'
  + 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & '
  + `"%_prog%"  "%dp0%\\${target}" %*\r\n`;

// cmd-shim <= 3.x.
const legacyJsShim = (target) => '@IF EXIST "%~dp0\\node.exe" (\r\n'
  + `  "%~dp0\\node.exe"  "%~dp0\\${target}" %*\r\n`
  + ') ELSE (\r\n'
  + '  @SETLOCAL\r\n'
  + '  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n'
  + `  node  "%~dp0\\${target}" %*\r\n`
  + ')';

// A case-insensitive in-memory filesystem, the way NTFS behaves.
const fakeFs = (files) => {
  const table = new Map(Object.entries(files).map(([path, text]) => [path.toLowerCase(), text]));
  return {
    existsSync: (path) => table.has(String(path).toLowerCase()),
    readFileSync: (path) => {
      const key = String(path).toLowerCase();
      if (!table.has(key)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return table.get(key);
    },
  };
};

// npm 11.21.0 bin/npx.cmd, verbatim (the Node installer copies it next to
// node.exe). Hand-written by npm, not a cmd-shim.
const NPM_NPX_CMD = ":: Created by npm, please don't edit manually.\r\n@ECHO OFF\r\n\r\nSETLOCAL\r\n\r\nSET \"NODE_EXE=%~dp0\\node.exe\"\r\nIF NOT EXIST \"%NODE_EXE%\" (\r\n  SET \"NODE_EXE=node\"\r\n)\r\n\r\nSET \"NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js\"\r\nSET \"NPX_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npx-cli.js\"\r\nFOR /F \"delims=\" %%F IN ('CALL \"%NODE_EXE%\" \"%NPM_PREFIX_JS%\"') DO (\r\n  SET \"NPM_PREFIX_NPX_CLI_JS=%%F\\node_modules\\npm\\bin\\npx-cli.js\"\r\n)\r\nIF EXIST \"%NPM_PREFIX_NPX_CLI_JS%\" (\r\n  SET \"NPX_CLI_JS=%NPM_PREFIX_NPX_CLI_JS%\"\r\n)\r\n\r\n\"%NODE_EXE%\" \"%NPX_CLI_JS%\" %*\r\n";

module.exports = {
  currentJsShim,
  currentExeShim,
  currentShShim,
  legacyJsShim,
  fakeFs,
  NPM_NPX_CMD,
};
