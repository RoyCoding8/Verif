import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { hash } from '../src/contracts.mjs';
import { classifyKaniReport } from '../src/kani-judge.mjs';
import { approve, createDemo } from '../examples/setup.mjs';
import { GitRepo } from '../src/git.mjs';
import { runTasks } from '../src/verity.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const leanSpec = join(root, 'verification/kani/Verdict.lean');
const smoke = process.env.VERITY_KANI_SMOKE === '1';

const states = {
  evidence: ['valid', 'invalid'],
  assertion: ['passed', 'failed', 'other'],
  probe: ['reached', 'unreachable', 'other'],
  exit: ['zero', 'counterexample', 'other'],
  error: ['none', 'assertion_failure', 'other'],
};

function indexOf({ evidence, assertion, probe, exit, error }) {
  const e = states.evidence.indexOf(evidence);
  const a = states.assertion.indexOf(assertion);
  const p = states.probe.indexOf(probe);
  const x = states.exit.indexOf(exit);
  const r = states.error.indexOf(error);
  return (((((e * 3 + a) * 3 + p) * 3 + x) * 3) + r);
}

function observedContext(expectedHarness, expectedProbes, exitCode) {
  const harnessSource = readFileSync(join(root, 'verification/kani/smoke.rs'), 'utf8');
  return {
    expectedHarness,
    expectedProbes,
    harnessSource,
    approvedHarnessDigest: hash(harnessSource),
    exitCode,
  };
}

const probeDescription = 'cover condition: output == 10';

function syntheticReport(observation) {
  const assertionStatus = { passed: 'Success', failed: 'Failure', other: 'Unknown' }[observation.assertion];
  const probeStatus = { reached: 'Satisfied', unreachable: 'Unsatisfiable', other: 'Unknown' }[observation.probe];
  const checks = [
    { id: 1, category: 'assertion', description: 'assertion failed: output <= 10', status: assertionStatus },
    { id: 2, category: 'cover', description: probeDescription, status: probeStatus },
  ];
  const propertyCounts = {
    total_properties: checks.length,
    passed: 0,
    failed: 0,
    unreachable: 0,
    undetermined: 0,
    solver_error: 0,
    satisfied: 0,
    unsatisfiable: 0,
    covered: 0,
    uncovered: 0,
  };
  if (assertionStatus === 'Success') propertyCounts.passed++;
  else if (assertionStatus === 'Failure') propertyCounts.failed++;
  else propertyCounts.undetermined++;
  if (probeStatus === 'Satisfied') propertyCounts.satisfied++;
  else if (probeStatus === 'Unsatisfiable') propertyCounts.unsatisfiable++;
  else propertyCounts.undetermined++;
  const failed = assertionStatus === 'Failure';
  const errorDetail = observation.error === 'assertion_failure'
    ? { harness_id: 'verity_test', has_errors: true, error_type: 'assertion_failure', exit_status: 'properties_failed' }
    : observation.error === 'other'
      ? { harness_id: 'verity_test', has_errors: true, error_type: 'tool_error', exit_status: 'failed' }
      : { harness_id: 'verity_test', has_errors: false };
  return {
    metadata: {
      version: observation.evidence === 'valid' ? '1.0' : '0.0',
      kani_version: '0.68.0',
    },
    tools: { kani: '0.68.0', cbmc: '6.11.0 (cbmc-6.11.0)' },
    harness_metadata: [{
      pretty_name: 'verity_test',
      attributes: { kind: 'Proof', should_panic: false },
      is_automatically_generated: false,
    }],
    verification_results: {
      summary: {
        total_harnesses: 1,
        executed: 1,
        status: 'completed',
        successful: Number(!failed),
        failed: Number(failed),
      },
      results: [{ harness_id: 'verity_test', status: failed ? 'Failure' : 'Success', checks }],
    },
    error_details: [errorDetail],
    property_details: [{ harness_id: 'verity_test', property_details: propertyCounts }],
  };
}

function classifyObservation(observation) {
  const exitCode = { zero: 0, counterexample: 1, other: 2 }[observation.exit];
  const outcome = classifyKaniReport(syntheticReport(observation), observedContext(
    'verity_test', [probeDescription], exitCode,
  ));
  if (outcome.verdict === 'PASS') return 'PASS';
  if (outcome.verdict === 'COUNTEREXAMPLE') {
    return outcome.reason === 'assertion_failure' ? 'ASSERTION_COUNTEREXAMPLE' : 'PROBE_COUNTEREXAMPLE';
  }
  return 'ERROR';
}

test('the report classifier matches the independent Lean finite contract', { skip: !smoke }, () => {
  const tableRows = execFileSync('lean', ['-DwarningAsError=true', '--run', leanSpec], {
    cwd: join(root, 'verification/lean'), encoding: 'utf8',
  })
    .trim().split(/\r?\n/);
  const reference = new Map(tableRows.map(line => {
    const [index, verdict] = line.split('=');
    return [Number(index), verdict];
  }));
  assert.equal(tableRows.length, 162);
  assert.equal(reference.size, 162);
  for (const evidence of states.evidence) {
    for (const assertion of states.assertion) {
      for (const probe of states.probe) {
        for (const exit of states.exit) {
          for (const error of states.error) {
            const observation = { evidence, assertion, probe, exit, error };
            assert.equal(classifyObservation(observation), reference.get(indexOf(observation)), JSON.stringify(observation));
          }
        }
      }
    }
  }
});

test('the finite contract kills a mutation that treats an unreachable probe as reached', () => {
  const observation = {
    evidence: 'valid', assertion: 'passed', probe: 'unreachable', exit: 'zero', error: 'none',
  };
  const mutant = value => classifyObservation({ ...value, probe: 'reached' });
  assert.equal(classifyObservation(observation), 'PROBE_COUNTEREXAMPLE');
  assert.equal(mutant(observation), 'PASS');
});

test('an unapproved harness and a missing tool report fail closed', () => {
  const context = observedContext('verity_positive', ['cover condition: output == 10'], 2);
  assert.deepEqual(classifyKaniReport(null, context), { verdict: 'ERROR', reason: 'tool_error' });
  assert.deepEqual(classifyKaniReport(null, { ...context, approvedHarnessDigest: '0'.repeat(64) }), {
    verdict: 'ERROR', reason: 'unapproved_harness',
  });
});

test('pinned Kani reports classify a pass, an assertion disproof, and a missed probe', {
  skip: !smoke,
}, () => {
  const report = name => JSON.parse(readFileSync(join(root, name), 'utf8'));
  const expectedProbe = ['cover condition: output == 10'];
  const counterexampleProbe = ['cover condition: output > 10'];
  const positive = classifyKaniReport(report('kani-smoke.json'),
    observedContext('verity_positive', expectedProbe, 0));
  const counterexample = classifyKaniReport(report('kani-counterexample.json'),
    observedContext('verity_counterexample', counterexampleProbe, Number(process.env.VERITY_KANI_COUNTEREXAMPLE_EXIT_CODE)));
  const unreachable = classifyKaniReport(report('kani-unreachable.json'),
    observedContext('verity_unreachable', expectedProbe, 0));
  const cliError = classifyKaniReport(null,
    observedContext('verity_positive', expectedProbe, Number(process.env.VERITY_KANI_CLI_ERROR_EXIT_CODE)));

  assert.deepEqual(positive, { verdict: 'PASS', reason: 'all_probes_reached' });
  assert.deepEqual(counterexample, { verdict: 'COUNTEREXAMPLE', reason: 'assertion_failure' });
  assert.deepEqual(unreachable, { verdict: 'COUNTEREXAMPLE', reason: 'probe_unreachable' });
  assert.deepEqual(cliError, { verdict: 'ERROR', reason: 'tool_error' });
  assert.equal(existsSync(join(root, 'kani-cli-error.json')), false);
});

test('the controller only promotes a Rust snapshot that passes its approved harness', { skip: !smoke }, async t => {
  const scratch = join(root, 'tmp');
  await mkdir(scratch, { recursive: true });
  const folder = await mkdtemp(join(scratch, 'kani-controller-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const fixture = await createDemo(folder);
  const oracleRoot = join(folder, 'oracles');
  await mkdir(oracleRoot);
  const harness = '#[kani::proof]\nfn check_cap() { let input: u8 = kani::any(); ' +
    'let output = subject::cap(input); assert!(output <= 10); kani::cover!(output == 10); }\n';
  const bytes = JSON.stringify({ kind: 'kani', source: 'cap.rs', harness, name: 'check_cap',
    probes: ['cover condition: output == 10'] });
  await writeFile(join(oracleRoot, 'kani.json'), bytes);
  const ref = 'refs/heads/protected';
  const repo = new GitRepo(fixture.repository);
  const head = repo.readRef(ref);
  const run = (id, source) => runTasks({ ...fixture, oracleRoot, tasks: [approve({
    id, revision: 1, goal: 'Cap the output at ten.', scope: { read: [], write: ['cap.rs'], forbidden: [] },
    policy: { ref, budgetMs: 90_000 }, claims: [{ id: 'cap', statement: 'Output is at most ten', required: 'bounded' }],
    criteria: [{ id: 'acceptance', description: 'Bounded cap', claims: ['cap'] }],
    obligations: [{ id: 'kani-check', claim: 'cap', method: 'kani', subject: 'candidate', expect: 'PASS',
      oracle: { file: 'kani.json', digest: hash(bytes) }, cases: ['check_cap'], timeoutMs: 30_000 }],
  })], worker: ({ workspace }) => writeFile(join(workspace, 'cap.rs'), source) });
  const [bad] = await run('bad-cap', 'pub fn cap(n: u8) -> u8 { n }\n');
  assert.equal(bad.status, 'refused');
  assert.equal(repo.readRef(ref), head);
  const [good] = await run('good-cap', 'pub fn cap(n: u8) -> u8 { if n > 10 { 10 } else { n } }\n');
  assert.equal(good.status, 'promoted', good.reason);
  assert.equal(repo.readRef(ref), good.commit);
  assert.equal(good.assurance.cap, 'bounded');
});
