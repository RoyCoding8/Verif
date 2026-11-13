import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';

const execute = promisify(execFile);
const leanVersion = '4.35.0';
const toolchainCommit = 'eb6cafb7290e8bd5f2937522d8d804f58f02bafc';
const theoremNamePattern = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const permittedAxioms = Object.freeze(['propext', 'Quot.sound', 'Classical.choice']);
const manifest = name => JSON.stringify({
  version: '1.1.0',
  packagesDir: '.lake/packages',
  packages: [],
  name,
  lakeDir: '.lake',
}, null, 2) + '\n';
const challengeLakefile = [
  'name = "verity_lean_challenge"',
  'version = "0.1.0"',
  'defaultTargets = ["Challenge"]',
  '',
  '[[lean_lib]]',
  'name = "Challenge"',
  '',
].join('\n');
const solutionLakefile = [
  'name = "verity_lean_solution"',
  'version = "0.1.0"',
  'defaultTargets = ["Solution"]',
  '',
  '[[lean_lib]]',
  'name = "Solution"',
  '',
].join('\n');

export const leanEnvironment = Object.freeze({
  adapter: 'verity-lean-judge/1',
  toolchain: 'leanprover/lean4:v4.35.0',
  toolchainCommit,
  platform: 'linux',
  challengeExport: 'lake env leanexport Challenge',
  comparator: ['lake', 'comparator', '--challenge-from-export=<file>', '--paranoid'],
  sandbox: 'Lake comparator bubblewrap; sandbox enabled',
  permittedAxioms,
});

function sourceText(value, name) {
  if (typeof value !== 'string' || Buffer.from(value, 'utf8').toString('utf8') !== value) {
    throw new TypeError(name + ' must be a valid UTF-8 source string');
  }
}

function checkRequest({ challenge, solution, theorem, theorems, timeoutMs, signal, scratch }) {
  sourceText(challenge, 'challenge');
  sourceText(solution, 'solution');
  if ((theorem === undefined) === (theorems === undefined)) {
    throw new TypeError('provide exactly one of theorem or theorems');
  }
  const theoremNames = theorem === undefined
    ? (Array.isArray(theorems) ? [...theorems] : theorems)
    : [theorem];
  if (!Array.isArray(theoremNames) || theoremNames.length === 0 ||
      theoremNames.some(name => typeof name !== 'string' || !theoremNamePattern.test(name))) {
    throw new TypeError('theorem names must be simple qualified Lean identifiers in a nonempty list');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new TypeError('timeoutMs must be a positive safe integer no greater than 2147483647');
  }
  if (typeof scratch !== 'string' || !isAbsolute(scratch)) throw new TypeError('scratch must be an absolute path');
  if (signal !== undefined &&
      (typeof signal.throwIfAborted !== 'function' || typeof signal.addEventListener !== 'function')) {
    throw new TypeError('signal must be an AbortSignal');
  }
  signal?.throwIfAborted();
  return theoremNames;
}

function commandEnvironment() {
  const env = {
    PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
  };
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (process.env.ELAN_HOME) env.ELAN_HOME = process.env.ELAN_HOME;
  return env;
}

async function runRequired(command, args, { cwd, env, deadline, signal, maxBuffer = 8 * 1024 * 1024 }) {
  signal?.throwIfAborted();
  const timeout = deadline - Date.now();
  if (timeout <= 0) throw new Error('Lean judge timed out before ' + command);
  try {
    return await execute(command, args, {
      cwd,
      env,
      timeout,
      signal,
      killSignal: 'SIGKILL',
      maxBuffer,
      windowsHide: true,
    });
  } catch (error) {
    throw new Error('Lean judge could not complete ' + command + ': ' + error.message, { cause: error });
  }
}

async function exportChallenge(cwd, outputFile, env, deadline, signal) {
  signal?.throwIfAborted();
  const timeout = deadline - Date.now();
  if (timeout <= 0) throw new Error('Lean judge timed out before exporting the challenge');
  const child = spawn('lake', ['env', 'leanexport', 'Challenge'], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const output = createWriteStream(outputFile, { flags: 'wx' });
  let spawnError;
  let timedOut = false;
  let stderrSize = 0;
  const stderrParts = [];
  let diagnosticsTooLarge = false;
  child.once('error', error => { spawnError = error; });
  child.stderr.on('data', chunk => {
    stderrSize += chunk.length;
    if (stderrSize > 8 * 1024 * 1024) {
      diagnosticsTooLarge = true;
      child.kill('SIGKILL');
    } else {
      stderrParts.push(chunk);
    }
  });
  output.on('error', () => child.kill('SIGKILL'));
  const piping = pipeline(child.stdout, output).catch(error => error);
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    child.kill('SIGKILL');
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeout);
  const closed = await new Promise(resolve => {
    child.once('close', (code, closeSignal) => resolve({ code, closeSignal }));
  });
  clearTimeout(timer);
  signal?.removeEventListener('abort', onAbort);
  const pipingError = await piping;
  const stderr = Buffer.concat(stderrParts).toString('utf8');
  if (aborted || signal?.aborted) signal?.throwIfAborted();
  if (timedOut) throw new Error('Lean judge timed out while exporting the trusted challenge');
  if (spawnError) throw new Error('Lean judge could not start trusted challenge export: ' + spawnError.message, { cause: spawnError });
  if (diagnosticsTooLarge) throw new Error('Lean judge trusted challenge export exceeded its diagnostic output limit');
  if (pipingError instanceof Error) throw new Error('Lean judge could not write the trusted challenge export: ' + pipingError.message, { cause: pipingError });
  if (closed.code !== 0) {
    throw new Error('Lean judge trusted challenge export exited with code ' + closed.code + ': ' + stderr);
  }
  if ((await stat(outputFile)).size === 0) throw new Error('Lean judge produced an empty trusted challenge export');
}

async function prepareProject(directory, name, sourceFile, sourceTextValue, lakefileText) {
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(join(directory, 'lean-toolchain'), leanEnvironment.toolchain + '\n', { flag: 'wx' }),
    writeFile(join(directory, 'lakefile.toml'), lakefileText, { flag: 'wx' }),
    writeFile(join(directory, 'lake-manifest.json'), manifest(name), { flag: 'wx' }),
    writeFile(join(directory, sourceFile), sourceTextValue, { flag: 'wx' }),
  ]);
}

async function runComparator(directory, challengeExport, theoremNames, env, deadline, signal) {
  const config = {
    challenge_module: 'Challenge',
    solution_module: 'Solution',
    theorem_names: theoremNames,
    permitted_axioms: permittedAxioms,
  };
  await writeFile(join(directory, 'comparator.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
  try {
    const result = await runRequired('lake', [
      'comparator',
      '--challenge-from-export=' + challengeExport,
      '--paranoid',
    ], { cwd: directory, env, deadline, signal });
    return { accepted: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (error.cause?.code === 1 || error.cause?.code === '1') {
      return {
        accepted: false,
        stdout: String(error.cause.stdout ?? ''),
        stderr: String(error.cause.stderr ?? ''),
      };
    }
    throw error;
  }
}

export async function judgeLean({ challenge, solution, theorem, theorems, timeoutMs, signal, scratch }) {
  const theoremNames = checkRequest({ challenge, solution, theorem, theorems, timeoutMs, signal, scratch });
  if (process.platform !== 'linux') throw new Error('Lean proof judging requires Linux with Lake comparator bubblewrap support');
  const deadline = Date.now() + timeoutMs;
  const env = commandEnvironment();
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'lean-judge-'));
  const challengeProject = join(root, 'challenge');
  const solutionProject = join(root, 'solution');
  const challengeExport = join(root, 'challenge.ndjson');
  try {
    await prepareProject(challengeProject, 'verity_lean_challenge', 'Challenge.lean', challenge, challengeLakefile);
    const version = await runRequired('lake', ['--version'], {
      cwd: challengeProject, env, deadline, signal,
    });
    const versionOutput = version.stdout + '\n' + version.stderr;
    if (!versionOutput.includes('Lean version ' + leanVersion) ||
        !versionOutput.includes(toolchainCommit.slice(0, 7))) {
      throw new Error('Lean judge toolchain mismatch: expected Lean ' + leanVersion +
        ' commit ' + toolchainCommit + ', got ' + versionOutput.trim());
    }
    await runRequired('lake', ['build', 'Challenge'], {
      cwd: challengeProject, env, deadline, signal,
    });
    await exportChallenge(challengeProject, challengeExport, env, deadline, signal);
    await prepareProject(solutionProject, 'verity_lean_solution', 'Solution.lean', solution, solutionLakefile);
    return await runComparator(solutionProject, challengeExport, theoremNames, env, deadline, signal);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
