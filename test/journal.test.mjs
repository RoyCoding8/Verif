import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { Journal } from '../src/journal.mjs';

function fixture() {
  const dir = mkdtempSync(join(process.cwd(), 'test', '.journal-'));
  const path = join(dir, 'journal.sqlite');
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { path, cleanup };
}

function request(overrides = {}) {
  return {
    id: 'op-1',
    attempt: 'attempt-1',
    contract: 'contract-a',
    policy: 'policy-a',
    ref: 'refs/heads/main',
    old: 'commit-a',
    next: 'commit-b',
    receipt: { result: 'verified', evidence: { digest: 'sha256:x' } },
    ...overrides,
  };
}

function start(journal) {
  journal.registerAttempt({ id: 'attempt-1', contract: 'contract-a', policy: 'policy-a' });
}

test('persists operation and authority, and accepts identical prepare retries', () => {
  const { path, cleanup } = fixture();
  try {
    let journal = new Journal(path);
    start(journal);
    const prepared = journal.prepare(request());
    journal.close();

    journal = new Journal(path);
    assert.deepEqual(journal.authority('attempt-1'), {
      id: 'attempt-1', contract: 'contract-a', policy: 'policy-a', active: true,
    });
    assert.deepEqual(journal.prepare(request({ receipt: { evidence: { digest: 'sha256:x' }, result: 'verified' } })), prepared);
    assert.deepEqual(journal.getOperation('op-1'), prepared);
    assert.throws(() => journal.prepare(request({ next: 'commit-c' })), /different content/);
    journal.close();
  } finally {
    cleanup();
  }
});

test('one outstanding operation per ref blocks later promotions until recovery', () => {
  const { path, cleanup } = fixture();
  try {
    const journal = new Journal(path);
    start(journal);
    journal.prepare(request());
    assert.equal(journal.getPending('refs/heads/main').id, 'op-1');
    assert.throws(() => journal.prepare(request({ id: 'op-2', old: 'commit-b', next: 'commit-c' })), /still outstanding/);

    let ref = 'commit-a';
    const promoted = journal.promote('op-1', {
      readRef: () => ref,
      recheck: op => op.receipt.result === 'verified',
      updateRef: (_ref, next, old) => {
        assert.equal(ref, old);
        ref = next;
      },
    });
    assert.equal(promoted.status, 'promoted');
    assert.equal(journal.getPending('refs/heads/main'), null);
    assert.equal(journal.prepare(request({ id: 'op-2', old: 'commit-b', next: 'commit-c' })).status, 'prepared');
    journal.close();
  } finally {
    cleanup();
  }
});

test('recovers an update that took effect before its callback threw', () => {
  const { path, cleanup } = fixture();
  try {
    const journal = new Journal(path);
    start(journal);
    journal.prepare(request());
    let ref = 'commit-a';
    assert.throws(() => journal.promote('op-1', {
      readRef: () => ref,
      recheck: () => true,
      updateRef: (_ref, next) => {
        ref = next;
        throw new Error('lost response after ref update');
      },
    }), /lost response/);
    assert.equal(journal.getOperation('op-1').status, 'prepared');

    journal.invalidate('attempt-1');
    let rechecked = false;
    const recovered = journal.promote('op-1', {
      readRef: () => ref,
      recheck: () => { rechecked = true; return true; },
      updateRef: () => assert.fail('ref was already updated'),
    });
    assert.equal(recovered.status, 'promoted');
    assert.equal(rechecked, false);
    journal.close();
  } finally {
    cleanup();
  }
});

test('requires current authority before updating from the old ref', () => {
  const { path, cleanup } = fixture();
  try {
    const journal = new Journal(path);
    start(journal);
    journal.prepare(request());
    journal.setPolicy('attempt-1', 'policy-b');
    assert.throws(() => journal.promote('op-1', {
      readRef: () => 'commit-a',
      recheck: () => true,
      updateRef: () => assert.fail('stale authority must not update the ref'),
    }), /no longer authorizes/);
    assert.equal(journal.getOperation('op-1').status, 'prepared');
    journal.close();
  } finally {
    cleanup();
  }
});

test('leaves divergent refs blocked for explicit recovery', () => {
  const { path, cleanup } = fixture();
  try {
    const journal = new Journal(path);
    start(journal);
    journal.prepare(request());
    assert.throws(() => journal.promote('op-1', {
      readRef: () => 'commit-elsewhere',
      recheck: () => true,
      updateRef: () => assert.fail('divergent ref must not update'),
    }), /expected commit-a or commit-b/);
    assert.equal(journal.getOperation('op-1').status, 'prepared');
    assert.throws(() => journal.prepare(request({ id: 'op-2' })), /still outstanding/);
    journal.close();
  } finally {
    cleanup();
  }
});

test('abandons an unapplied operation and releases its ref for later work', () => {
  const { path, cleanup } = fixture();
  try {
    const journal = new Journal(path);
    start(journal);
    journal.prepare(request());
    const abandoned = journal.abandon('op-1', { readRef: () => 'commit-a' });
    assert.equal(abandoned.status, 'abandoned');
    assert.equal(journal.getPending('refs/heads/main'), null);
    assert.deepEqual(journal.abandon('op-1', { readRef: () => assert.fail('terminal retry must not read ref') }), abandoned);
    assert.throws(() => journal.promote('op-1', {
      readRef: () => 'commit-a',
      recheck: () => true,
      updateRef: () => assert.fail('abandoned operation must not promote'),
    }), /was abandoned/);
    assert.equal(journal.prepare(request({ id: 'op-2', next: 'commit-c' })).status, 'prepared');
    journal.close();
  } finally {
    cleanup();
  }
});

test('abandon reconciles a ref already at next to promoted', () => {
  const { path, cleanup } = fixture();
  try {
    const journal = new Journal(path);
    start(journal);
    journal.prepare(request());
    const promoted = journal.abandon('op-1', { readRef: () => 'commit-b' });
    assert.equal(promoted.status, 'promoted');
    assert.deepEqual(journal.abandon('op-1', { readRef: () => assert.fail('terminal retry must not read ref') }), promoted);
    journal.close();
  } finally {
    cleanup();
  }
});

test('abandons and preserves an operation whose ref moved elsewhere', () => {
  const { path, cleanup } = fixture();
  try {
    const journal = new Journal(path);
    start(journal);
    const prepared = journal.prepare(request());
    const abandoned = journal.abandon('op-1', { readRef: () => 'commit-elsewhere' });
    assert.equal(abandoned.status, 'abandoned');
    assert.deepEqual(journal.getOperation('op-1'), abandoned);
    assert.equal(prepared.id, abandoned.id);
    journal.close();
  } finally {
    cleanup();
  }
});

test('migrates existing journal records to the abandoned state schema', () => {
  const { path, cleanup } = fixture();
  try {
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE attempts (
        id TEXT PRIMARY KEY, contract TEXT NOT NULL, policy TEXT NOT NULL,
        active INTEGER NOT NULL CHECK (active IN (0, 1))
      );
      CREATE TABLE operations (
        id TEXT PRIMARY KEY, attempt TEXT NOT NULL REFERENCES attempts(id),
        contract TEXT NOT NULL, policy TEXT NOT NULL, ref TEXT NOT NULL,
        old TEXT NOT NULL, next TEXT NOT NULL, receipt TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('prepared', 'promoted'))
      );
      CREATE UNIQUE INDEX one_prepared_operation_per_ref
        ON operations(ref) WHERE status = 'prepared';
      INSERT INTO attempts VALUES ('attempt-1', 'contract-a', 'policy-a', 1);
      INSERT INTO operations VALUES (
        'op-1', 'attempt-1', 'contract-a', 'policy-a', 'refs/heads/main',
        'commit-a', 'commit-b', '{"result":"verified"}', 'prepared'
      );
    `);
    db.close();

    const journal = new Journal(path);
    assert.equal(journal.getOperation('op-1').status, 'prepared');
    assert.equal(journal.abandon('op-1', { readRef: () => 'commit-a' }).status, 'abandoned');
    journal.close();
  } finally {
    cleanup();
  }
});

test('persists run identity by task set and approvals', () => {
  const { path, cleanup } = fixture();
  try {
    let journal = new Journal(path);
    const tasks = [
      { id: 'task-b', approval: { principal: 'reviewer', scope: ['write'] } },
      { id: 'task-a', approval: true },
    ];
    assert.deepEqual(journal.registerRun('run-1', tasks), [
      { id: 'task-a', approval: true, status: 'queued', result: null },
      { id: 'task-b', approval: { principal: 'reviewer', scope: ['write'] }, status: 'queued', result: null },
    ]);
    journal.close();

    journal = new Journal(path);
    assert.equal(journal.startTask('run-1', 'task-a').status, 'running');
    const retryTasks = [...tasks].reverse().map(task => task.id === 'task-b'
      ? { ...task, approval: { scope: ['write'], principal: 'reviewer' } }
      : task);
    assert.equal(journal.registerRun('run-1', retryTasks)[0].status, 'running');
    assert.throws(() => journal.registerRun('run-1', [
      { id: 'task-a', approval: true },
      { id: 'task-b', approval: { principal: 'reviewer', scope: ['read'] } },
    ]), /different task set/);
    assert.throws(() => journal.registerRun('run-1', [
      { id: 'task-a', approval: true },
      { id: 'task-a', approval: false },
    ]), /unique/);
    journal.close();
  } finally {
    cleanup();
  }
});

test('enforces task transitions and idempotent terminal results', () => {
  const { path, cleanup } = fixture();
  try {
    const journal = new Journal(path);
    journal.registerRun('run-1', [
      { id: 'promote', approval: 'approved' },
      { id: 'refuse', approval: 'approved' },
      { id: 'block', approval: 'approved' },
    ]);
    assert.equal(journal.startTask('run-1', 'promote').status, 'running');
    assert.throws(() => journal.startTask('run-1', 'promote'), /already running/);
    const promoted = journal.finishTask('run-1', 'promote', { status: 'promoted', receipt: 'r1' });
    assert.equal(promoted.status, 'promoted');
    assert.deepEqual(journal.finishTask('run-1', 'promote', { receipt: 'r1', status: 'promoted' }), promoted);
    assert.throws(() => journal.finishTask('run-1', 'promote', { status: 'refused' }), /different result/);

    const blocked = journal.finishTask('run-1', 'block', { reason: 'not started' });
    assert.equal(blocked.status, 'blocked');
    assert.deepEqual(journal.finishTask('run-1', 'block', { reason: 'not started' }), blocked);
    assert.throws(() => journal.finishTask('run-1', 'block', { reason: 'changed' }), /different result/);
    assert.equal(journal.startTask('run-1', 'refuse').status, 'running');
    assert.equal(journal.finishTask('run-1', 'refuse', { status: 'refused' }).status, 'refused');
    assert.throws(() => journal.finishTask('run-1', 'missing', { status: 'refused' }), /unknown task/);
    assert.throws(() => journal.startTask('unknown-run', 'promote'), /unknown task/);
    assert.deepEqual(journal.runTasks('run-1').map(task => task.status), ['blocked', 'promoted', 'refused']);
    journal.close();
  } finally {
    cleanup();
  }
});

test('requeues only running tasks as an explicit transition', () => {
  const { path, cleanup } = fixture();
  try {
    const journal = new Journal(path);
    journal.registerRun('run-1', [{ id: 'task-a', approval: true }]);
    assert.throws(() => journal.requeueTask('run-1', 'task-a'), /not running/);
    journal.startTask('run-1', 'task-a');
    assert.equal(journal.requeueTask('run-1', 'task-a').status, 'queued');
    assert.equal(journal.startTask('run-1', 'task-a').status, 'running');
    assert.equal(journal.finishTask('run-1', 'task-a', { status: 'promoted' }).status, 'promoted');
    assert.throws(() => journal.requeueTask('run-1', 'task-a'), /not running/);
    journal.close();
  } finally {
    cleanup();
  }
});

test('finds the latest promoted operation recorded for a run task', () => {
  const { path, cleanup } = fixture();
  try {
    const journal = new Journal(path);
    start(journal);
    const promote = (id, refName, old, next) => {
      journal.prepare(request({
        id,
        ref: refName,
        old,
        next,
        receipt: { runId: 'run-1', task: { contract: { id: 'task-a' } } },
      }));
      let ref = old;
      return journal.promote(id, {
        readRef: () => ref,
        recheck: () => true,
        updateRef: (_ref, target) => { ref = target; },
      });
    };

    assert.equal(journal.getTaskPromotion('run-1', 'task-a'), null);
    promote('op-1', 'refs/heads/one', 'one-a', 'one-b');
    const latest = promote('op-2', 'refs/heads/two', 'two-a', 'two-b');
    assert.equal(journal.getTaskPromotion('run-1', 'task-a').id, latest.id);
    assert.equal(journal.getTaskPromotion('run-other', 'task-a'), null);
    journal.close();
  } finally {
    cleanup();
  }
});
