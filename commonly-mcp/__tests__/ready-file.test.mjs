import { createReadyFileWriter, READY_FILE_ENV } from '../src/ready-file.js';

describe('ready file', () => {
  it('writes nothing without the variable', () => {
    const calls = [];
    const mark = createReadyFileWriter({}, { write: (...a) => calls.push(a) });
    expect(mark()).toBe(false);
    expect(calls).toEqual([]);
  });

  it('creates the file once, exclusively and 0600, however often initialize arrives', () => {
    const calls = [];
    const mark = createReadyFileWriter({ [READY_FILE_ENV]: '/x/ready' }, { write: (...a) => calls.push(a) });
    expect(mark()).toBe(true);
    expect(mark()).toBe(false);
    expect(calls).toEqual([['/x/ready', 'ready\n', { flag: 'wx', mode: 0o600 }]]);
  });

  it('refuses a relative path, so it never writes where the cwd happens to be', () => {
    const calls = []; const warned = [];
    const mark = createReadyFileWriter({ [READY_FILE_ENV]: 'ready' }, { write: (...a) => calls.push(a), warn: (l) => warned.push(l) });
    expect(mark()).toBe(false);
    expect(calls).toEqual([]);
    expect(warned[0]).toMatch(/not an absolute path/);
  });

  it('reports a failed write without throwing', () => {
    const warned = [];
    const mark = createReadyFileWriter({ [READY_FILE_ENV]: '/x/ready' }, {
      write: () => { const e = new Error('exists'); e.code = 'EEXIST'; throw e; },
      warn: (l) => warned.push(l),
    });
    expect(mark()).toBe(false);
    expect(warned[0]).toMatch(/could not write the ready file: EEXIST/);
  });
});
