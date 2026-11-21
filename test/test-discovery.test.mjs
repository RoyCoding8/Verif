import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
// The test harness marks its children; a nested node --test inheriting this skips all files.
const { NODE_TEST_CONTEXT, NODE_TEST_WORKER_ID, ...childEnv } = process.env;
const probeName = 'verity-discovery-probe-7f3a';
const scratchDir = mkdtempSync(join(tmpdir(), 'verity-discovery-'));
const marker = join(scratchDir, 'probe-ran');
const probeFile = join(repoRoot, 'tmp', 'discovery-probe.test.mjs');

test.after(() => {
  rmSync(scratchDir, { recursive: true, force: true });
  // The nested runner loads this file too; it must not delete the shared probe.
  if (!process.env.VERITY_DISCOVERY_RUNNER) rmSync(probeFile, { force: true });
});

function writeProbe() {
  mkdirSync(dirname(probeFile), { recursive: true });
  writeFileSync(probeFile, [
    "import test from 'node:test';",
    `import { writeFileSync } from 'node:fs';`,
    `test('${probeName}', () => { writeFileSync(${JSON.stringify(marker)}, 'ran'); });`,
    '',
  ].join('\n'));
}

// A probe that is never selected proves nothing; this shows it runs when selected.
test('the tmp probe runs when its file is explicitly selected', async t => {
  writeProbe();
  await run(process.execPath, ['--test', `--test-name-pattern=${probeName}`, probeFile],
    { cwd: repoRoot, env: childEnv });
  assert.equal(existsSync(marker), true, 'the probe must run when its file is selected');
});

test('npm test runs controller tests and excludes ignored tmp archives', async () => {
  writeProbe();
  rmSync(marker, { force: true });
  const options = [childEnv.NODE_OPTIONS, `--test-name-pattern=${probeName}`, '--test-reporter=tap']
    .filter(Boolean).join(' ');
  const npm = await run(isWindows ? 'npm test' : 'npm', isWindows ? [] : ['test'], {
    cwd: repoRoot,
    env: { ...childEnv, NODE_OPTIONS: options, VERITY_DISCOVERY_RUNNER: '1' },
    maxBuffer: 64 * 1024 * 1024,
    shell: isWindows,
  }).catch(error => error);
  assert.equal(npm.code ?? 0, 0, `npm test must pass with everything filtered:\n${npm.stderr ?? ''}`);

  const files = [...npm.stdout.matchAll(/^(?:ok|not ok) \d+ - (.+\.test\.mjs)$/gm)]
    .map(match => match[1].replaceAll('\\', '/'));
  assert.ok(files.length > 0, 'npm test must discover test files');
  for (const file of files) {
    assert.match(file, /^test\/.+\.test\.mjs$/, `unexpected selection: ${file}`);
  }
  assert.equal(existsSync(marker), false, 'a tmp archive must not run under npm test');
});
