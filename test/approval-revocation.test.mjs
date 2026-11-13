import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { Journal } from '../src/journal.mjs';
import {
  effectiveAuthority,
  explore,
  initialState,
  promotionInvariant,
  stateKey,
  transition,
  values,
} from '../verification/ApprovalRevocationLaw.mjs';

const run = promisify(execFile);
const { approvalA, approvalB } = values;
const operation = {
  id: 'operation-a',
  attempt: 'attempt-a',
  contract: approvalA,
  policy: 'policy-a',
  ref: 'refs/heads/main',
  old: 'old',
  next: 'next',
  receipt: { evidence: 'verified', historical: 'keep-me' },
};

function fixture() {
  const root = join(process.cwd(), 'tmp');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'approval-revocation-'));
  return {
    directory,
    journalPath: join(directory, 'journal.sqlite'),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test('revocation is an irreversible per-digest gate across late runs, connections, and restart', async t => {
  const { directory, journalPath, cleanup } = fixture();
  t.after(cleanup);
  const first = new Journal(journalPath);
  const second = new Journal(journalPath);
  let model = initialState;
  try {
    model = transition(model, { type: 'revoke', approval: approvalA }).state;
    assert.deepEqual(second.revokeApproval(approvalA), { approval: approvalA, status: 'revoked' });
    assert.deepEqual(first.revokeApproval(approvalA), { approval: approvalA, status: 'already_revoked' });
  } finally {
    second.close();
    first.close();
  }

  const reopened = new Journal(journalPath);
  try {
    assert.equal(reopened.isApprovalRevoked(approvalA), true);
    assert.equal(reopened.isApprovalRevoked(approvalB), false);
    assert.throws(() => reopened.isApprovalRevoked('contract-a'), /canonical lowercase SHA-256 digest/);
    reopened.registerRun('late-run', [{ id: 'task-a', approval: approvalA }]);
    const claim = reopened.startTask('late-run', 'task-a').claim;
    const late = transition(model, { type: 'register', id: 'late-a', approval: approvalA });
    assert.equal(late.outcome, 'revoked');
    assert.throws(() => reopened.registerAttempt({ id: 'late-a', contract: approvalA, policy: 'policy-a' }),
      new RegExp(`approval digest ${approvalA} has been revoked; refusing attempt registration`));
    assert.throws(() => reopened.registerAttempt({
      id: 'late-bound-a', contract: approvalA, policy: 'policy-a',
      runId: 'late-run', taskId: 'task-a', claim,
    }), new RegExp(`approval digest ${approvalA} has been revoked; refusing attempt registration`));

    model = transition(model, { type: 'register', id: 'attempt-b', approval: approvalB }).state;
    assert.deepEqual(reopened.registerAttempt({ id: 'attempt-b', contract: approvalB, policy: 'policy-a' }), {
      id: 'attempt-b', contract: approvalB, policy: 'policy-a', active: true,
    });
    model = transition(model, { type: 'register', id: 'attempt-b2', approval: approvalB }).state;
    reopened.registerAttempt({ id: 'attempt-b2', contract: approvalB, policy: 'policy-a' });
    model = transition(model, { type: 'cancel', id: 'attempt-b' }).state;
    reopened.invalidate('attempt-b');
    assert.equal(reopened.authority('attempt-b').active, effectiveAuthority(model, 'attempt-b'));
    assert.equal(reopened.authority('attempt-b2').active, effectiveAuthority(model, 'attempt-b2'));
  } finally {
    reopened.close();
  }
});

test('revocation and promotion serialize; revoked prepared work cannot move the ref', t => {
  const { journalPath, cleanup } = fixture();
  t.after(cleanup);
  const promoter = new Journal(journalPath);
  const revoker = new Journal(journalPath);
  let model = initialState;
  let ref = 'old';
  try {
    model = transition(model, { type: 'register', id: 'attempt-a', approval: approvalA }).state;
    promoter.registerAttempt({ id: 'attempt-a', contract: approvalA, policy: 'policy-a' });
    model = transition(model, { type: 'prepare', attemptId: 'attempt-a' }).state;
    promoter.prepare(operation);
    model = transition(model, { type: 'revoke', approval: approvalA }).state;
    revoker.revokeApproval(approvalA);

    assert.equal(promoter.authority('attempt-a').active, effectiveAuthority(model, 'attempt-a'));
    const expected = transition(model, { type: 'promote', attemptId: 'attempt-a' });
    assert.equal(expected.outcome, 'revoked');
    assert.throws(() => promoter.promote(operation.id, {
      readRef: () => ref,
      recheck: () => true,
      updateRef: (_name, next) => { ref = next; },
    }), /approval digest .* has been revoked/);
    assert.equal(ref, 'old');
    assert.equal(promoter.getOperation(operation.id).status, 'prepared');
    assert.equal(promotionInvariant({
      from: model,
      to: expected.state,
      action: { type: 'promote', attemptId: 'attempt-a' },
      outcome: expected.outcome,
    }), true);
  } finally {
    revoker.close();
    promoter.close();
  }
});

test('recovery records an already-moved ref after revocation without rewriting the receipt', t => {
  const { journalPath, cleanup } = fixture();
  t.after(cleanup);
  const first = new Journal(journalPath);
  const second = new Journal(journalPath);
  let model = initialState;
  let ref = 'old';
  let prepared;
  try {
    model = transition(model, { type: 'register', id: 'attempt-a', approval: approvalA }).state;
    first.registerAttempt({ id: 'attempt-a', contract: approvalA, policy: 'policy-a' });
    model = transition(model, { type: 'prepare', attemptId: 'attempt-a' }).state;
    prepared = first.prepare(operation);
    model = transition(model, { type: 'loseWriteResponse', attemptId: 'attempt-a' }).state;
    assert.throws(() => first.promote(operation.id, {
      readRef: () => ref,
      recheck: () => true,
      updateRef: (_name, next) => { ref = next; throw new Error('simulated lost response'); },
    }), /simulated lost response/);
    assert.equal(ref, 'next');
    assert.equal(first.getOperation(operation.id).status, 'prepared');
    model = transition(model, { type: 'revoke', approval: approvalA }).state;
    second.revokeApproval(approvalA);
  } finally {
    second.close();
    first.close();
  }

  const reopened = new Journal(journalPath);
  try {
    const expected = transition(model, { type: 'promote', attemptId: 'attempt-a' });
    assert.equal(expected.outcome, 'recovered');
    const recovered = reopened.promote(operation.id, {
      readRef: () => ref,
      recheck: () => assert.fail('recovery must not recheck historical work'),
      updateRef: () => assert.fail('recovery must not write the ref again'),
    });
    model = expected.state;
    assert.equal(recovered.status, 'promoted');
    assert.deepEqual(recovered.receipt, prepared.receipt);
    assert.deepEqual(reopened.getOperation(operation.id), recovered);
    assert.equal(promotionInvariant({
      from: { ...model, ref: 'next', operation: { ...model.operation, status: 'prepared' } },
      to: model,
      action: { type: 'promote', attemptId: 'attempt-a' },
      outcome: expected.outcome,
    }), true);
  } finally {
    reopened.close();
  }
});

test('finite transition relation preserves revocation and exposes the stale-authority mutant', () => {
  const graph = explore();
  assert.ok(graph.states.length > 1);
  for (const state of graph.states) {
    for (const attempt of state.attempts) {
      if (state.revoked.includes(attempt.approval)) {
        assert.equal(effectiveAuthority(state, attempt.id), false);
      }
    }
  }
  for (const edge of graph.edges) assert.equal(promotionInvariant(edge), true);

  const revoked = transition(initialState, { type: 'revoke', approval: approvalA }).state;
  const lateRegistration = { type: 'register', id: 'late-a', approval: approvalA };
  assert.equal(transition(revoked, lateRegistration).outcome, 'revoked');
  const mutant = transition(revoked, lateRegistration, { ignoreRevocation: true });
  assert.equal(mutant.outcome, 'registered');
  assert.equal(effectiveAuthority(mutant.state, 'late-a', { ignoreRevocation: true }), true);
  assert.equal(effectiveAuthority(mutant.state, 'late-a'), false);
});

test('all reachable single-digest transitions match SQLite journal observations', t => {
  const graph = explore();
  const uniqueEdges = new Map(graph.edges.map(edge => [
    JSON.stringify([stateKey(edge.from), edge.action, edge.outcome]), edge,
  ]));
  assert.equal(graph.states.length, 18);
  assert.equal(uniqueEdges.size, 38);
  for (const edge of uniqueEdges.values()) assert.equal(promotionInvariant(edge), true);

  const root = join(process.cwd(), 'tmp');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'approval-revocation-diff-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const observe = (journal, ref) => ({
    ref: ref.value,
    attempt: journal.authority(operation.attempt)?.active ?? null,
    operation: journal.getOperation('operation-a')?.status ?? null,
  });
  const expectedObservation = model => ({
    ref: model.ref,
    attempt: model.attempts.length ? effectiveAuthority(model, operation.attempt) : null,
    operation: model.operation?.status ?? null,
  });
  const apply = (journal, ref, action, outcome) => {
    if (action.type === 'revoke') {
      assert.equal(journal.revokeApproval(action.approval).status, outcome);
    } else if (action.type === 'register') {
      if (outcome === 'revoked') {
        assert.throws(() => journal.registerAttempt({
          id: action.id, contract: action.approval, policy: 'policy-a',
        }), /has been revoked/);
      } else {
        assert.equal(journal.registerAttempt({
          id: action.id, contract: action.approval, policy: 'policy-a',
        }).active, true);
      }
    } else if (action.type === 'cancel') {
      journal.invalidate(action.id);
    } else if (action.type === 'prepare') {
      journal.prepare({ ...operation, attempt: action.attemptId });
    } else if (action.type === 'loseWriteResponse') {
      assert.throws(() => journal.promote(operation.id, {
        readRef: () => ref.value,
        recheck: () => true,
        updateRef: (_name, next) => { ref.value = next; throw new Error('simulated lost response'); },
      }), /simulated lost response/);
    } else if (action.type === 'promote') {
      let updates = 0;
      const request = {
        readRef: () => ref.value,
        recheck: () => true,
        updateRef: (_name, next, old) => {
          updates += 1;
          assert.equal(ref.value, old);
          ref.value = next;
        },
      };
      if (['revoked', 'inactive', 'refused'].includes(outcome)) {
        assert.throws(() => journal.promote(operation.id, request));
        assert.equal(updates, 0);
      } else {
        assert.equal(journal.promote(operation.id, request).status, 'promoted');
        assert.equal(updates, outcome === 'promoted' ? 1 : 0);
      }
    } else {
      assert.fail('unmapped reference action ' + action.type);
    }
  };

  let index = 0;
  for (const edge of uniqueEdges.values()) {
    const journal = new Journal(join(directory, `case-${index++}.sqlite`));
    const ref = { value: 'old' };
    let model = initialState;
    try {
      const path = [...graph.paths.get(stateKey(edge.from)), edge.action];
      for (const action of path) {
        const expected = transition(model, action);
        apply(journal, ref, action, expected.outcome);
        model = expected.state;
        assert.deepEqual(observe(journal, ref), expectedObservation(model));
      }
      assert.deepEqual(model, edge.to);
    } finally {
      journal.close();
    }
  }
  assert.equal(index, 38);
});

test('CLI can revoke a digest absent from an older manifest and reports repeat revocation', async t => {
  const { directory, cleanup } = fixture();
  t.after(cleanup);
  const manifest = join(directory, 'older-manifest.json');
  writeFileSync(manifest, JSON.stringify({ repository: directory, tasks: [{ approval: approvalB }] }));
  const cli = resolve('src/cli.mjs');
  assert.equal(existsSync(join(directory, '.verity')), false);
  const first = await run(process.execPath, [cli, 'revoke', manifest, approvalA]);
  assert.deepEqual(JSON.parse(first.stdout), { approval: approvalA, status: 'revoked' });
  assert.equal(existsSync(join(directory, '.verity')), true);
  const second = await run(process.execPath, [cli, 'revoke', manifest, approvalA]);
  assert.deepEqual(JSON.parse(second.stdout), { approval: approvalA, status: 'already_revoked' });
  await assert.rejects(run(process.execPath, [cli, 'revoke', manifest, 'not-a-digest']), error =>
    error.code === 1 && /canonical lowercase SHA-256 digest/.test(error.stderr));
});

test('opening an existing journal preserves its attempts and prepared receipts while adding revocation', t => {
  const { journalPath, cleanup } = fixture();
  t.after(cleanup);
  const legacy = new DatabaseSync(journalPath);
  legacy.exec(`
    CREATE TABLE attempts (
      id TEXT PRIMARY KEY,
      contract TEXT NOT NULL,
      policy TEXT NOT NULL,
      active INTEGER NOT NULL CHECK (active IN (0, 1))
    );
    CREATE TABLE operations (
      id TEXT PRIMARY KEY,
      attempt TEXT NOT NULL REFERENCES attempts(id),
      contract TEXT NOT NULL,
      policy TEXT NOT NULL,
      ref TEXT NOT NULL,
      old TEXT NOT NULL,
      next TEXT NOT NULL,
      receipt TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('prepared', 'promoted'))
    );
    INSERT INTO attempts VALUES ('old-attempt', '${approvalA}', 'policy-a', 1);
    INSERT INTO operations VALUES (
      'old-operation', 'old-attempt', '${approvalA}', 'policy-a',
      'refs/heads/main', 'old', 'next', '{"receipt":"keep-me"}', 'prepared'
    );
  `);
  legacy.close();

  const journal = new Journal(journalPath);
  try {
    const before = journal.getOperation('old-operation');
    assert.equal(before.status, 'prepared');
    assert.deepEqual(before.receipt, { receipt: 'keep-me' });
    assert.equal(journal.authority('old-attempt').active, true);
    journal.revokeApproval(approvalA);
    assert.equal(journal.authority('old-attempt').active, false);
    assert.deepEqual(journal.getOperation('old-operation'), before);
  } finally {
    journal.close();
  }
});
