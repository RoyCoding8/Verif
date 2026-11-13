import { hash } from './contracts.mjs';

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
const count = value => Number.isSafeInteger(value) && value >= 0;
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
  const propertyCountKeys = Object.keys(requiredCounts).filter(key => key !== 'total_properties');
  if (Object.entries(requiredCounts).some(([key, expected]) => details[key] !== expected) ||
      propertyCountKeys.some(key => !count(details[key])) ||
      propertyCountKeys.reduce((sum, key) => sum + details[key], 0) !== details.total_properties) {
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
