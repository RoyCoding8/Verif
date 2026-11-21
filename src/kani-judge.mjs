import { execFile } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { hash, requireThat, safePath, text } from './contracts.mjs';

const execute = promisify(execFile);

export function parseKaniOracle(oracle) {
  const { kind, source, harness, name, probes } = oracle ?? {};
  requireThat(kind === 'kani' && safePath(source) && source.endsWith('.rs') &&
    text(harness) && typeof name === 'string' && /^[a-zA-Z_][a-zA-Z_0-9]*$/.test(name) &&
    Array.isArray(probes) && probes.length > 0 && probes.every(text) && new Set(probes).size === probes.length,
  'Invalid Kani oracle');
  requireThat(!/\bstub\b|\bassume\s*\(\s*false\s*\)/.test(harness), 'Unsupported Kani harness directive');
  return { source, harness, name, probes };
}

export function kaniHarness(recipe) {
  return '#[path = "subject.rs"]\nmod subject;\n' + recipe.harness;
}

export async function runKani({ recipe, source, directory, deadline, signal }) {
  requireThat(process.platform === 'linux', 'Kani verification requires Linux');
  const body = new TextDecoder('utf-8', { fatal: true }).decode(source);
  requireThat(/^[\t\n\r\x20-\x7e]+$/.test(body) &&
    !/[#]|!(?!=)|\b(?:kani|mod|extern|unsafe)\b/.test(body), 'Unsupported Rust subject syntax for Kani');
  await mkdir(directory);
  await writeFile(join(directory, 'subject.rs'), source, { flag: 'wx' });
  const harness = kaniHarness(recipe);
  await writeFile(join(directory, 'harness.rs'), harness, { flag: 'wx' });
  const timeout = deadline - Date.now();
  requireThat(timeout > 0, 'Kani deadline expired');
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' };
  const { stdout, stderr, exit } = await execute('kani', ['-Z', 'unstable-options', 'harness.rs', '--harness',
    recipe.name, '--export-json', 'report.json'], { cwd: directory, env, timeout, signal, killSignal: 'SIGKILL' })
    .then(result => ({ ...result, exit: 0 })).catch(error => {
      if (error.code !== 1 || error.killed || error.signal) throw error;
      return { stdout: error.stdout, stderr: error.stderr, exit: 1 };
    });
  const file = join(directory, 'report.json');
  requireThat((await stat(file)).size <= 2 * 1024 * 1024, 'Oversized Kani report');
  const report = JSON.parse(await readFile(file, 'utf8'));
  const verdict = classifyKaniReport(report, { expectedHarness: recipe.name, expectedProbes: recipe.probes,
    harnessSource: harness, approvedHarnessDigest: hash(harness), exitCode: exit });
  requireThat(verdict.verdict !== 'ERROR', 'Kani verification error: ' + verdict.reason);
  return { stdout, stderr, exit, verdict, report, sourceDigest: hash(source), harnessDigest: hash(harness) };
}

export const kaniJudgePin = {
  reportVersion: '1.0',
  kaniVersion: '0.68.0',
  cbmcVersion: '6.11.0 (cbmc-6.11.0)',
};

function classifyObservation(observation) {
  const evidenceStates = ['valid', 'invalid'];
  const assertionStates = ['passed', 'failed', 'other'];
  const probeStates = ['reached', 'unreachable', 'other'];
  const exitStates = ['zero', 'counterexample', 'other'];
  const errorStates = ['none', 'assertion_failure', 'other'];
  const { evidence, assertion, probe, exit, error } = observation ?? {};
  if (!evidenceStates.includes(evidence) || !assertionStates.includes(assertion) ||
      !probeStates.includes(probe) || !exitStates.includes(exit) || !errorStates.includes(error)) {
    return 'ERROR';
  }
  if (evidence !== 'valid') return 'ERROR';
  if (assertion === 'failed' && exit === 'counterexample' && error === 'assertion_failure') {
    return 'ASSERTION_COUNTEREXAMPLE';
  }
  if (assertion === 'passed' && probe === 'unreachable' && exit === 'zero' && error === 'none') {
    return 'PROBE_COUNTEREXAMPLE';
  }
  if (assertion === 'passed' && probe === 'reached' && exit === 'zero' && error === 'none') {
    return 'PASS';
  }
  return 'ERROR';
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const result = (verdict, reason) => ({ verdict, reason });
const error = reason => result('ERROR', reason);

function reportObservation(report, { expectedHarness, expectedProbes, exitCode }) {
  if (!record(report)) return { reason: exitCode === 0 ? 'missing_report' : 'tool_error' };
  const { metadata, tools, harness_metadata: harnesses, verification_results: verification,
    error_details: errors, property_details: properties } = report;
  if (!record(metadata) || metadata.version !== kaniJudgePin.reportVersion ||
      metadata.kani_version !== kaniJudgePin.kaniVersion || !record(tools) ||
      tools.kani !== kaniJudgePin.kaniVersion || tools.cbmc !== kaniJudgePin.cbmcVersion) {
    return { reason: 'tool_mismatch' };
  }
  if (!Array.isArray(harnesses) || harnesses.length !== 1 ||
      harnesses[0]?.pretty_name !== expectedHarness ||
      harnesses[0]?.attributes?.kind !== 'Proof' ||
      harnesses[0]?.attributes?.should_panic !== false ||
      harnesses[0]?.is_automatically_generated !== false) {
    return { reason: 'harness_inventory_mismatch' };
  }
  if (!record(verification) || !record(verification.summary) ||
      verification.summary.status !== 'completed' || verification.summary.total_harnesses !== 1 ||
      verification.summary.executed !== 1 || !Array.isArray(verification.results) ||
      verification.results.length !== 1 || verification.results[0]?.harness_id !== expectedHarness ||
      !['Success', 'Failure'].includes(verification.results[0]?.status) ||
      !Array.isArray(verification.results[0]?.checks)) {
    return { reason: 'incomplete_report' };
  }

  const checks = verification.results[0].checks;
  const assertionChecks = checks.filter(check => check?.category === 'assertion');
  const coverChecks = checks.filter(check => check?.category === 'cover');
  if (assertionChecks.length + coverChecks.length !== checks.length || assertionChecks.length === 0 ||
      assertionChecks.some(check => !['Success', 'Failure'].includes(check.status)) ||
      coverChecks.some(check => !['Satisfied', 'Unsatisfiable'].includes(check.status))) {
    return { reason: 'unsupported_property' };
  }

  if (!Array.isArray(expectedProbes) || expectedProbes.length === 0 ||
      expectedProbes.some(probe => typeof probe !== 'string' || !probe) ||
      new Set(expectedProbes).size !== expectedProbes.length || coverChecks.length !== expectedProbes.length ||
      expectedProbes.some(probe => coverChecks.filter(check => check.description === probe).length !== 1)) {
    return { reason: 'probe_inventory_mismatch' };
  }

  if (!Array.isArray(errors) || errors.length !== 1 || errors[0]?.harness_id !== expectedHarness ||
      !Array.isArray(properties) || properties.length !== 1 || properties[0]?.harness_id !== expectedHarness ||
      !record(properties[0]?.property_details)) {
    return { reason: 'incomplete_report' };
  }
  const details = properties[0].property_details;
  const assertionPassed = assertionChecks.filter(check => check.status === 'Success').length;
  const assertionFailed = assertionChecks.filter(check => check.status === 'Failure').length;
  const probesReached = coverChecks.filter(check => check.status === 'Satisfied').length;
  const probesUnreachable = coverChecks.filter(check => check.status === 'Unsatisfiable').length;
  const requiredCounts = {
    total_properties: checks.length,
    passed: assertionPassed,
    failed: assertionFailed,
    unreachable: 0,
    undetermined: 0,
    solver_error: 0,
    satisfied: probesReached,
    unsatisfiable: probesUnreachable,
    covered: 0,
    uncovered: 0,
  };
  if (Object.entries(requiredCounts).some(([key, expected]) => details[key] !== expected)) {
    return { reason: 'property_counts_mismatch' };
  }

  const summary = verification.summary;
  const runFailed = assertionFailed > 0;
  if (summary.successful !== Number(!runFailed) || summary.failed !== Number(runFailed) ||
      verification.results[0].status !== (runFailed ? 'Failure' : 'Success')) {
    return { reason: 'summary_mismatch' };
  }
  const errorDetail = errors[0];
  let errorState = 'none';
  if (runFailed) {
    if (errorDetail.has_errors !== true || errorDetail.error_type !== 'assertion_failure' ||
        errorDetail.exit_status !== 'properties_failed' || exitCode !== 1) {
      return { reason: 'error_report_mismatch' };
    }
    errorState = 'assertion_failure';
  } else if (errorDetail.has_errors !== false || exitCode !== 0) {
    return { reason: 'error_report_mismatch' };
  }

  return {
    observation: {
      evidence: 'valid',
      assertion: runFailed ? 'failed' : 'passed',
      probe: probesUnreachable ? 'unreachable' : 'reached',
      exit: exitCode === 0 ? 'zero' : exitCode === 1 ? 'counterexample' : 'other',
      error: errorState,
    },
  };
}

export function classifyKaniReport(report, {
  expectedHarness,
  expectedProbes,
  harnessSource,
  approvedHarnessDigest,
  exitCode,
} = {}) {
  if (typeof expectedHarness !== 'string' || !expectedHarness || typeof harnessSource !== 'string' ||
      !/^[a-f0-9]{64}$/.test(approvedHarnessDigest ?? '') || !Number.isInteger(exitCode) ||
      !Array.isArray(expectedProbes) || expectedProbes.length === 0) {
    return error('invalid_context');
  }
  if (hash(harnessSource) !== approvedHarnessDigest) return error('unapproved_harness');
  const parsed = reportObservation(report, { expectedHarness, expectedProbes, exitCode });
  if (parsed.reason) return error(parsed.reason);
  const outcome = classifyObservation(parsed.observation);
  if (outcome === 'ASSERTION_COUNTEREXAMPLE') return result('COUNTEREXAMPLE', 'assertion_failure');
  if (outcome === 'PROBE_COUNTEREXAMPLE') return result('COUNTEREXAMPLE', 'probe_unreachable');
  if (outcome === 'PASS') return result('PASS', 'all_probes_reached');
  return error('unclassified_evidence');
}
