import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const driver = 'import sys; sys.path.insert(0, sys.argv[1]); import tui; sys.exit(tui.spawn(sys.argv[2:]))';

function scratch(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  return { directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

function findPython() {
  for (const name of ['python', 'py', 'python3']) {
    try {
      execFileSync(name, ['--version'], { stdio: 'ignore' });
      return name;
    } catch {
      // keep looking
    }
  }
  return null;
}

function probe(name) {
  try {
    execFileSync(name, ['--version'], { stdio: 'ignore' });
    return name;
  } catch {
    return null;
  }
}

// Runs the launcher's command runner with a controlled child, from an external cwd.
function launch(python, childArgv, cwd) {
  return run(python, ['-c', driver, repoRoot, ...childArgv], { cwd }).catch(error => error);
}

let callerCwd;

test.before(() => {
  callerCwd = scratch('verity-launcher-caller-').directory;
});

test.after(() => rmSync(callerCwd, { recursive: true, force: true }));

test('tui.py runs commands in the repository directory and forwards exact child exit codes', async t => {
  const python = findPython();
  if (!python) return t.skip('no python interpreter on PATH');

  const printed = await launch(python, [python, '-c', 'import os; print(os.getcwd())'], callerCwd);
  assert.equal(printed.code ?? 0, 0);
  assert.equal(printed.stdout.trim(), repoRoot,
    'a command launched from another cwd must run in the repository directory');

  const ok = await launch(python, [python, '-c', 'import sys; sys.exit(0)'], callerCwd);
  assert.equal(ok.code ?? 0, 0, 'a succeeding child must yield exit 0');

  const failing = await launch(python, [python, '-c', 'import sys; sys.exit(9)'], callerCwd);
  assert.equal(failing.code, 9, 'a failing child must yield its exact exit code');
});

test('tui.bat forwards the interpreter exit code on every branch', async t => {
  if (!isWindows) return t.skip('tui.bat is Windows-only');
  const { directory, cleanup } = scratch('verity-launcher-bat-');
  t.after(cleanup);
  const base = `${process.env.SystemRoot}\\System32`;
  const cases = [
    { shim: 'python.cmd', path: join(directory, 'case-python') },
    { shim: 'py.cmd', path: join(directory, 'case-py') },
    { shim: 'python3.cmd', path: join(directory, 'case-python3') },
  ];
  for (const { shim, path } of cases) {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, shim), '@echo off\r\nexit /b 9\r\n');
  }
  for (const { shim, path } of cases) {
    const forwarded = await run('cmd', ['/c', join(repoRoot, 'tui.bat')], {
      cwd: callerCwd,
      env: { ...process.env, PATH: `${path};${base}` },
    }).catch(error => error);
    assert.equal(forwarded.code, 9, `the ${shim} branch must forward the child's exit code`);
  }
  const missing = await run('cmd', ['/c', join(repoRoot, 'tui.bat')], {
    cwd: callerCwd,
    env: { ...process.env, PATH: base },
  }).catch(error => error);
  assert.equal(missing.code, 1, 'no interpreter must yield exit 1');
  assert.match(missing.stderr, /no python interpreter found/);
});

test('the wrappers run this repository launcher from any cwd', async t => {
  const bash = probe('bash');
  if (!bash) return t.skip('no bash on PATH');
  const checked = await run(bash, [join(repoRoot, 'tui.sh'), '--check'], { cwd: callerCwd });
  assert.equal(checked.code ?? 0, 0);
  assert.match(checked.stdout, /VERDICT/);
  const listed = await run(bash, [join(repoRoot, 'tui.sh'), '--list'], { cwd: callerCwd });
  assert.match(listed.stdout, /Run the test suite\tnpm test/,
    'the suite command must be the unified npm test selection');
  if (!isWindows) return;
  const winChecked = await run('cmd', ['/c', join(repoRoot, 'tui.bat'), '--check'], { cwd: callerCwd });
  assert.equal(winChecked.code ?? 0, 0);
  assert.match(winChecked.stdout, /VERDICT/);
});

test('tui.sh forwards the child exit code', async t => {
  const bash = probe('bash');
  if (!bash) return t.skip('no bash on PATH');
  const { directory, cleanup } = scratch('verity-launcher-sh-');
  t.after(cleanup);
  copyFileSync(join(repoRoot, 'tui.sh'), join(directory, 'tui.sh'));
  writeFileSync(join(directory, 'tui.py'), 'import sys\nsys.exit(int(sys.argv[1]))\n');
  const forwarded = await run(bash, [join(directory, 'tui.sh'), '7'], { cwd: callerCwd }).catch(error => error);
  assert.equal(forwarded.code, 7, 'tui.sh must forward the child exit code');
});
