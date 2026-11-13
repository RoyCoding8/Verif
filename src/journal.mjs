import { DatabaseSync } from 'node:sqlite';
import { digest } from './contracts.mjs';

const fields = ['id', 'attempt', 'contract', 'policy', 'ref', 'old', 'next'];

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function requireApprovalDigest(value) {
  value = requireString(value, 'approval');
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError('approval must be a canonical lowercase SHA-256 digest');
  }
  return value;
}

function canonicalJsonValue(value, name) {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError(`${name} must be JSON serializable`);
  const parsed = JSON.parse(json);
  const sort = item => Array.isArray(item)
    ? item.map(sort)
    : item && typeof item === 'object'
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])]))
      : item;
  return JSON.stringify(sort(parsed));
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('receipt must be a JSON object');
  }
  const json = canonicalJsonValue(value, 'receipt');
  const parsed = JSON.parse(json);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('receipt must serialize to a JSON object');
  }
  return json;
}

function evidenceFromRow(key, row) {
  try {
    const value = JSON.parse(row.payload);
    return canonicalJsonValue(value, 'evidence') === row.payload && digest({ key, value }) === row.payload_digest ? value : null;
  } catch {
    return null;
  }
}

function taskFromRow(row) {
  return {
    id: row.task_id,
    approval: JSON.parse(row.approval),
    status: row.status,
    claim: row.claim,
    startedMs: row.started_ms ?? null,
    result: row.result_set === 1 ? JSON.parse(row.result) : null,
  };
}

function operationFromRow(row) {
  return {
    id: row.id,
    attempt: row.attempt,
    contract: row.contract,
    policy: row.policy,
    ref: row.ref,
    old: row.old,
    next: row.next,
    receipt: JSON.parse(row.receipt),
    status: row.status,
  };
}

function sameOperation(row, values, receipt) {
  return fields.every(field => row[field] === values[field]) && row.receipt === receipt;
}

function syncResult(value, name) {
  if (value && typeof value.then === 'function') {
    throw new TypeError(`${name} must be synchronous`);
  }
  return value;
}

export class Journal {
  #db;

  constructor(path) {
    this.#db = new DatabaseSync(requireString(path, 'path'));
    this.#db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY,
        contract TEXT NOT NULL,
        policy TEXT NOT NULL,
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        run_id TEXT REFERENCES runs(id),
        task_id TEXT,
        claim INTEGER,
        CHECK ((run_id IS NULL AND task_id IS NULL AND claim IS NULL) OR
               (run_id IS NOT NULL AND task_id IS NOT NULL AND claim IS NOT NULL AND claim > 0))
      );
      CREATE TABLE IF NOT EXISTS revoked_approvals (
        approval TEXT PRIMARY KEY CHECK (length(approval) = 64 AND approval NOT GLOB '*[^0-9a-f]*')
      );
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,
        attempt TEXT NOT NULL REFERENCES attempts(id),
        contract TEXT NOT NULL,
        policy TEXT NOT NULL,
        ref TEXT NOT NULL,
        old TEXT NOT NULL,
        next TEXT NOT NULL,
        receipt TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('prepared', 'promoted', 'abandoned'))
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS evidence_reuse (
        run_key TEXT PRIMARY KEY CHECK (length(run_key) = 64),
        payload TEXT NOT NULL,
        payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64)
      );
      CREATE TABLE IF NOT EXISTS run_usage (
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('tool calls', 'verification time')),
        spent INTEGER NOT NULL CHECK (spent >= 0),
        PRIMARY KEY (run_id, task_id, kind),
        FOREIGN KEY (run_id, task_id) REFERENCES run_tasks(run_id, task_id)
      );
      CREATE TABLE IF NOT EXISTS verifier_refusals (
        attempt TEXT NOT NULL REFERENCES attempts(id),
        evidence TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (attempt, evidence)
      );
      CREATE TABLE IF NOT EXISTS model_usage (
        attempt TEXT PRIMARY KEY REFERENCES attempts(id),
        tokens INTEGER NOT NULL CHECK (tokens >= 0),
        estimated_cost REAL NOT NULL CHECK (estimated_cost >= 0)
      );
      CREATE TABLE IF NOT EXISTS run_tasks (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,
        approval TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'blocked', 'promoted', 'refused')),
        claim INTEGER NOT NULL DEFAULT 0 CHECK (claim >= 0),
        started_ms INTEGER,
        max_attempts INTEGER CHECK (max_attempts > 0),
        result TEXT,
        result_set INTEGER NOT NULL CHECK (result_set IN (0, 1)),
        PRIMARY KEY (run_id, task_id),
        CHECK ((result_set = 0 AND result IS NULL) OR (result_set = 1 AND result IS NOT NULL))
      );
    `);
    const attemptColumns = new Set(this.#db.prepare('PRAGMA table_info(attempts)').all().map(column => column.name));
    if (!attemptColumns.has('run_id')) this.#db.exec('ALTER TABLE attempts ADD COLUMN run_id TEXT REFERENCES runs(id)');
    if (!attemptColumns.has('task_id')) this.#db.exec('ALTER TABLE attempts ADD COLUMN task_id TEXT');
    if (!attemptColumns.has('claim')) this.#db.exec('ALTER TABLE attempts ADD COLUMN claim INTEGER');
    this.#db.exec('CREATE INDEX IF NOT EXISTS attempts_by_task ON attempts (run_id, task_id)');
    const taskColumns = new Set(this.#db.prepare('PRAGMA table_info(run_tasks)').all().map(column => column.name));
    if (!taskColumns.has('claim')) {
      this.#db.exec('ALTER TABLE run_tasks ADD COLUMN claim INTEGER NOT NULL DEFAULT 0 CHECK (claim >= 0)');
    }
    if (!taskColumns.has('started_ms')) this.#db.exec('ALTER TABLE run_tasks ADD COLUMN started_ms INTEGER');
    if (!taskColumns.has('max_attempts')) {
      this.#db.exec('ALTER TABLE run_tasks ADD COLUMN max_attempts INTEGER CHECK (max_attempts > 0)');
    }
    const schema = this.#db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'operations'").get();
    if (!schema.sql.includes("'abandoned'")) {
      this.#db.exec(`
        BEGIN IMMEDIATE;
        DROP INDEX IF EXISTS one_prepared_operation_per_ref;
        ALTER TABLE operations RENAME TO operations_legacy;
        CREATE TABLE operations (
          id TEXT PRIMARY KEY,
          attempt TEXT NOT NULL REFERENCES attempts(id),
          contract TEXT NOT NULL,
          policy TEXT NOT NULL,
          ref TEXT NOT NULL,
          old TEXT NOT NULL,
          next TEXT NOT NULL,
          receipt TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('prepared', 'promoted', 'abandoned'))
        );
        INSERT INTO operations SELECT * FROM operations_legacy;
        DROP TABLE operations_legacy;
        CREATE UNIQUE INDEX one_prepared_operation_per_ref
          ON operations(ref) WHERE status = 'prepared';
        COMMIT;
      `);
    } else {
      this.#db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS one_prepared_operation_per_ref
          ON operations(ref) WHERE status = 'prepared';
      `);
    }
  }

  close() {
    this.#db.close();
  }

  #transaction(action) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  #isApprovalRevoked(approval) {
    return Boolean(this.#db.prepare('SELECT 1 FROM revoked_approvals WHERE approval = ?').get(approval));
  }

  isApprovalRevoked(approval) {
    return this.#isApprovalRevoked(requireApprovalDigest(approval));
  }

  revokeApproval(approval) {
    approval = requireApprovalDigest(approval);
    return this.#transaction(() => {
      const inserted = this.#db.prepare('INSERT OR IGNORE INTO revoked_approvals (approval) VALUES (?)').run(approval);
      return { approval, status: inserted.changes === 1 ? 'revoked' : 'already_revoked' };
    });
  }

  registerAttempt({ id, contract, policy, runId, taskId, claim }) {
    id = requireString(id, 'id');
    contract = requireString(contract, 'contract');
    policy = requireString(policy, 'policy');
    const bound = runId !== undefined || taskId !== undefined || claim !== undefined;
    if (bound) {
      runId = requireString(runId, 'runId');
      taskId = requireString(taskId, 'taskId');
      if (!Number.isSafeInteger(claim) || claim < 1) throw new TypeError('claim must be a positive safe integer');
    }
    return this.#transaction(() => {
      if (this.#isApprovalRevoked(contract)) {
        throw new Error(`approval digest ${contract} has been revoked; refusing attempt registration`);
      }
      const existing = this.#db.prepare('SELECT * FROM attempts WHERE id = ?').get(id);
      if (existing) {
        if (existing.contract !== contract || existing.policy !== policy ||
            existing.run_id !== (bound ? runId : null) ||
            existing.task_id !== (bound ? taskId : null) ||
            existing.claim !== (bound ? claim : null)) {
          throw new Error(`attempt ${id} is already registered with different authority`);
        }
        return this.authority(id);
      }
      if (bound) {
        const task = this.#db.prepare('SELECT status, claim, approval, max_attempts FROM run_tasks WHERE run_id = ? AND task_id = ?')
          .get(runId, taskId);
        if (!task || task.status !== 'running' || task.claim !== claim ||
            task.approval !== canonicalJsonValue(contract, 'contract')) {
          throw new Error(`task ${taskId} in run ${runId} does not authorize contract ${contract} at claim ${claim}`);
        }
        if (task.max_attempts !== null) {
          const { spent, active } = this.#db.prepare(`
            SELECT COUNT(*) AS spent, COUNT(CASE WHEN active = 1 AND claim = ? THEN 1 END) AS active
            FROM attempts WHERE run_id = ? AND task_id = ?
          `).get(claim, runId, taskId);
          if (active) throw new Error(`task ${taskId} already has an active attempt`);
          if (spent >= task.max_attempts) throw new Error(`Task attempt budget exhausted for ${taskId}`);
        }
      }
      this.#db.prepare(`
        INSERT INTO attempts (id, contract, policy, active, run_id, task_id, claim)
        VALUES (?, ?, ?, 1, ?, ?, ?)
      `).run(id, contract, policy, bound ? runId : null, bound ? taskId : null, bound ? claim : null);
      return this.authority(id);
    });
  }

  authority(id) {
    id = requireString(id, 'id');
    const row = this.#db.prepare(`
      SELECT id, contract, policy, active, run_id, task_id, claim
      FROM attempts WHERE id = ?
    `).get(id);
    if (!row) return null;
    let active = row.active === 1 && !this.#isApprovalRevoked(row.contract);
    if (active && row.run_id !== null) {
      const task = this.#db.prepare('SELECT status, claim FROM run_tasks WHERE run_id = ? AND task_id = ?')
        .get(row.run_id, row.task_id);
      active = !!task && task.status === 'running' && task.claim === row.claim;
    }
    return { id: row.id, contract: row.contract, policy: row.policy, active };
  }

  attemptNumber(id) {
    const row = this.#db.prepare(`
      SELECT (SELECT COUNT(*) FROM attempts prior WHERE prior.run_id = current.run_id
        AND prior.task_id = current.task_id AND prior.rowid <= current.rowid) AS number
      FROM attempts current WHERE current.id = ? AND current.run_id IS NOT NULL
    `).get(requireString(id, 'id'));
    return row?.number ?? null;
  }

  reserveUsage(id, kind, amount, limit) {
    id = requireString(id, 'id');
    if (![amount, limit].every(value => Number.isSafeInteger(value) && value >= 0) || amount < 1) {
      throw new TypeError('Invalid budget reservation');
    }
    this.#transaction(() => {
      const attempt = this.#db.prepare('SELECT run_id, task_id FROM attempts WHERE id = ?').get(id);
      if (!attempt?.run_id || !this.authority(id)?.active) throw new Error('Attempt cannot reserve resources');
      const row = this.#db.prepare('SELECT spent FROM run_usage WHERE run_id = ? AND task_id = ? AND kind = ?')
        .get(attempt.run_id, attempt.task_id, kind);
      const spent = row?.spent ?? 0;
      if (amount > limit - spent) throw new Error('Task budget exhausted for ' + kind);
      this.#db.prepare(`
        INSERT INTO run_usage (run_id, task_id, kind, spent) VALUES (?, ?, ?, ?)
        ON CONFLICT (run_id, task_id, kind) DO UPDATE SET spent = excluded.spent
      `).run(attempt.run_id, attempt.task_id, kind, spent + amount);
    });
  }

  recordVerifierRefusal(attempt, result) {
    this.#db.prepare('INSERT OR IGNORE INTO verifier_refusals (attempt, evidence, payload) VALUES (?, ?, ?)')
      .run(requireString(attempt, 'attempt'), requireString(result.evidence, 'evidence'), canonicalJson(result));
  }

  verifierRefusals(runId) {
    return this.#db.prepare(`
      SELECT records.attempt, attempts.task_id, records.payload FROM verifier_refusals records
      JOIN attempts ON attempts.id = records.attempt WHERE attempts.run_id = ? ORDER BY records.rowid
    `).all(requireString(runId, 'runId')).map(row => ({ task: row.task_id, attempt: row.attempt, ...JSON.parse(row.payload) }));
  }

  hasVerifierRefusal(attempt, evidence) {
    return Boolean(this.#db.prepare('SELECT 1 FROM verifier_refusals WHERE attempt = ? AND evidence = ?').get(attempt, evidence));
  }

  recordModelUsage(attempt, usage) {
    const tokens = usage?.tokens?.total;
    const cost = usage?.estimatedCost;
    if (!Number.isSafeInteger(tokens) || tokens < 0 || !Number.isFinite(cost) || cost < 0) return;
    this.#db.prepare('INSERT OR IGNORE INTO model_usage (attempt, tokens, estimated_cost) VALUES (?, ?, ?)')
      .run(requireString(attempt, 'attempt'), tokens, cost);
  }

  modelUsage(runId) {
    const { attempts, tokens, estimatedCost } = this.#db.prepare(`
      SELECT COUNT(*) AS attempts, COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(estimated_cost), 0) AS estimatedCost
      FROM model_usage JOIN attempts ON attempts.id = model_usage.attempt WHERE attempts.run_id = ?
    `).get(requireString(runId, 'runId'));
    return { reportedAttempts: attempts, tokens, estimatedCost };
  }

  invalidate(id) {
    id = requireString(id, 'id');
    const result = this.#db.prepare('UPDATE attempts SET active = 0 WHERE id = ?').run(id);
    if (result.changes === 0) throw new Error(`unknown attempt ${id}`);
  }

  setPolicy(id, policy) {
    id = requireString(id, 'id');
    policy = requireString(policy, 'policy');
    const result = this.#db.prepare('UPDATE attempts SET policy = ? WHERE id = ?').run(policy, id);
    if (result.changes === 0) throw new Error(`unknown attempt ${id}`);
    return this.authority(id);
  }

  prepare(request) {
    const values = Object.fromEntries(fields.map(field => [field, requireString(request?.[field], field)]));
    if (values.old === values.next) throw new TypeError('old and next must differ');
    const receipt = canonicalJson(request.receipt);
    return this.#transaction(() => {
      const existing = this.#db.prepare('SELECT * FROM operations WHERE id = ?').get(values.id);
      if (existing) {
        if (!sameOperation(existing, values, receipt)) {
          throw new Error(`operation ${values.id} was already prepared with different content`);
        }
        return operationFromRow(existing);
      }

      if (this.#isApprovalRevoked(values.contract)) {
        throw new Error(`approval digest ${values.contract} has been revoked; refusing operation ${values.id}`);
      }

      const authority = this.authority(values.attempt);
      if (!authority || !authority.active || authority.contract !== values.contract || authority.policy !== values.policy) {
        throw new Error(`attempt ${values.attempt} does not authorize this operation`);
      }
      const attempt = this.#db.prepare('SELECT run_id, task_id, claim FROM attempts WHERE id = ?').get(values.attempt);
      const receiptData = JSON.parse(receipt);
      const receiptRun = receiptData.runId;
      const receiptTask = receiptData.task?.contract?.id;
      const receiptClaim = receiptData.claim;
      const hasTaskBinding = receiptRun !== undefined || receiptTask !== undefined;
      if (attempt.run_id !== null) {
        if (receiptRun !== attempt.run_id || receiptTask !== attempt.task_id || receiptClaim !== attempt.claim) {
          throw new Error(`operation ${values.id} receipt does not match attempt ${values.attempt}`);
        }
      } else if (hasTaskBinding) {
        throw new Error(`task-bound operation ${values.id} requires a task-bound attempt`);
      }
      const outstanding = this.#db.prepare("SELECT id FROM operations WHERE ref = ? AND status = 'prepared'").get(values.ref);
      if (outstanding) throw new Error(`operation ${outstanding.id} is still outstanding for ref ${values.ref}`);

      this.#db.prepare(`
        INSERT INTO operations (id, attempt, contract, policy, ref, old, next, receipt, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared')
      `).run(values.id, values.attempt, values.contract, values.policy, values.ref,
        values.old, values.next, receipt);
      return operationFromRow(this.#db.prepare('SELECT * FROM operations WHERE id = ?').get(values.id));
    });
  }

  promote(id, { readRef, updateRef, recheck }) {
    id = requireString(id, 'id');
    if (typeof readRef !== 'function' || typeof updateRef !== 'function' || typeof recheck !== 'function') {
      throw new TypeError('readRef, updateRef, and recheck must be functions');
    }
    return this.#transaction(() => {
      const row = this.#db.prepare('SELECT * FROM operations WHERE id = ?').get(id);
      if (!row) throw new Error(`unknown operation ${id}`);
      if (row.status === 'promoted') return operationFromRow(row);
      if (row.status === 'abandoned') throw new Error(`operation ${id} was abandoned`);

      const op = operationFromRow(row);
      const current = syncResult(readRef(op.ref), 'readRef');
      if (current === op.next) {
        this.#db.prepare("UPDATE operations SET status = 'promoted' WHERE id = ?").run(id);
        return { ...op, status: 'promoted' };
      }
      if (current !== op.old) {
        throw new Error(`ref ${op.ref} is at ${String(current)}, expected ${op.old} or ${op.next}`);
      }

      const authority = this.authority(op.attempt);
      if (this.#isApprovalRevoked(op.contract)) {
        throw new Error(`approval digest ${op.contract} has been revoked; operation ${id} cannot update ref ${op.ref}`);
      }
      if (!authority || !authority.active || authority.contract !== op.contract || authority.policy !== op.policy) {
        throw new Error(`attempt ${op.attempt} no longer authorizes operation ${id}`);
      }
      if (syncResult(recheck(op), 'recheck') === false) {
        throw new Error(`recheck rejected operation ${id}`);
      }
      if (syncResult(updateRef(op.ref, op.next, op.old), 'updateRef') === false) {
        throw new Error(`ref update rejected for ${op.ref}`);
      }
      this.#db.prepare("UPDATE operations SET status = 'promoted' WHERE id = ?").run(id);
      return { ...op, status: 'promoted' };
    });
  }

  abandon(id, { readRef }) {
    id = requireString(id, 'id');
    if (typeof readRef !== 'function') throw new TypeError('readRef must be a function');
    return this.#transaction(() => {
      const row = this.#db.prepare('SELECT * FROM operations WHERE id = ?').get(id);
      if (!row) throw new Error(`unknown operation ${id}`);
      if (row.status !== 'prepared') return operationFromRow(row);

      const op = operationFromRow(row);
      const current = syncResult(readRef(op.ref), 'readRef');
      if (current === op.next) {
        this.#db.prepare("UPDATE operations SET status = 'promoted' WHERE id = ?").run(id);
        return { ...op, status: 'promoted' };
      }
      this.#db.prepare("UPDATE operations SET status = 'abandoned' WHERE id = ?").run(id);
      return { ...op, status: 'abandoned' };
    });
  }

  getOperation(id) {
    id = requireString(id, 'id');
    const row = this.#db.prepare('SELECT * FROM operations WHERE id = ?').get(id);
    return row ? operationFromRow(row) : null;
  }

  getPending(ref) {
    ref = requireString(ref, 'ref');
    const row = this.#db.prepare("SELECT * FROM operations WHERE ref = ? AND status = 'prepared'").get(ref);
    return row ? operationFromRow(row) : null;
  }

  getTaskPromotion(runId, taskId) {
    runId = requireString(runId, 'runId');
    taskId = requireString(taskId, 'taskId');
    const row = this.#db.prepare(`
      SELECT * FROM operations
      WHERE status = 'promoted'
        AND json_extract(receipt, '$.runId') = ?
        AND json_extract(receipt, '$.task.contract.id') = ?
      ORDER BY rowid DESC
      LIMIT 1
    `).get(runId, taskId);
    return row ? operationFromRow(row) : null;
  }

  registerRun(id, tasks) {
    id = requireString(id, 'id');
    if (!Array.isArray(tasks)) throw new TypeError('tasks must be an array');
    const entries = tasks.map(task => {
      if (!task || typeof task !== 'object' || !Object.hasOwn(task, 'approval')) {
        throw new TypeError('each task must include an approval');
      }
      const maxAttempts = task.maxAttempts ?? null;
      if (maxAttempts !== null && (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1)) {
        throw new TypeError('maxAttempts must be a positive safe integer');
      }
      return {
        id: requireString(task.id, 'task id'),
        approval: canonicalJsonValue(task.approval, 'approval'),
        maxAttempts,
      };
    });
    if (new Set(entries.map(task => task.id)).size !== entries.length) {
      throw new Error('task ids must be unique within a run');
    }

    return this.#transaction(() => {
      const existing = this.#db.prepare('SELECT id FROM runs WHERE id = ?').get(id);
      if (existing) {
        const stored = this.#db.prepare(
          'SELECT task_id, approval, max_attempts FROM run_tasks WHERE run_id = ? ORDER BY task_id',
        ).all(id);
        const byId = new Map(stored.map(row => [row.task_id, row]));
        if (stored.length !== entries.length || entries.some(task => byId.get(task.id)?.approval !== task.approval ||
          (byId.get(task.id).max_attempts !== null && byId.get(task.id).max_attempts !== task.maxAttempts))) {
          throw new Error(`run ${id} was already registered with a different task set`);
        }
        const initialize = this.#db.prepare('UPDATE run_tasks SET max_attempts = ? WHERE run_id = ? AND task_id = ? AND max_attempts IS NULL');
        for (const task of entries) if (task.maxAttempts !== null) initialize.run(task.maxAttempts, id, task.id);
        return this.runTasks(id);
      }

      this.#db.prepare('INSERT INTO runs (id) VALUES (?)').run(id);
      const insert = this.#db.prepare(`
        INSERT INTO run_tasks (run_id, task_id, approval, max_attempts, status, claim, started_ms, result, result_set)
        VALUES (?, ?, ?, ?, 'queued', 0, NULL, NULL, 0)
      `);
      for (const task of entries) insert.run(id, task.id, task.approval, task.maxAttempts);
      return this.runTasks(id);
    });
  }

  runTasks(id) {
    id = requireString(id, 'id');
    if (!this.#db.prepare('SELECT 1 FROM runs WHERE id = ?').get(id)) {
      throw new Error(`unknown run ${id}`);
    }
    return this.#db.prepare('SELECT * FROM run_tasks WHERE run_id = ? ORDER BY task_id')
      .all(id).map(taskFromRow);
  }

  reusableEvidence(key) {
    key = requireString(key, 'run key');
    if (!/^[a-f0-9]{64}$/.test(key)) throw new TypeError('run key must be a SHA-256 digest');
    const row = this.#db.prepare('SELECT payload, payload_digest FROM evidence_reuse WHERE run_key = ?').get(key);
    return row ? evidenceFromRow(key, row) : null;
  }

  rememberEvidence(key, value) {
    key = requireString(key, 'run key');
    if (!/^[a-f0-9]{64}$/.test(key)) throw new TypeError('run key must be a SHA-256 digest');
    const payload = canonicalJson(value);
    const payloadDigest = digest({ key, value: JSON.parse(payload) });
    this.#transaction(() => {
      const existing = this.#db.prepare('SELECT payload, payload_digest FROM evidence_reuse WHERE run_key = ?').get(key);
      if (!existing) {
        this.#db.prepare('INSERT INTO evidence_reuse (run_key, payload, payload_digest) VALUES (?, ?, ?)')
          .run(key, payload, payloadDigest);
      } else if (evidenceFromRow(key, existing) === null) {
        this.#db.prepare('UPDATE evidence_reuse SET payload = ?, payload_digest = ? WHERE run_key = ?')
          .run(payload, payloadDigest, key);
      }
    });
    const stored = this.reusableEvidence(key);
    return stored !== null && digest({ key, value: stored }) === payloadDigest;
  }

  startTask(run, id) {
    run = requireString(run, 'run');
    id = requireString(id, 'task id');
    return this.#transaction(() => {
      const row = this.#db.prepare('SELECT * FROM run_tasks WHERE run_id = ? AND task_id = ?').get(run, id);
      if (!row) throw new Error(`unknown task ${id} in run ${run}`);
      if (row.status === 'running') throw new Error(`task ${id} is already running`);
      if (row.status !== 'queued') throw new Error(`task ${id} is ${row.status}, not queued`);
      this.#db.prepare(`
        UPDATE run_tasks
        SET status = 'running', claim = claim + 1, started_ms = COALESCE(started_ms, ?)
        WHERE run_id = ? AND task_id = ?
      `).run(Date.now(), run, id);
      return taskFromRow(this.#db.prepare('SELECT * FROM run_tasks WHERE run_id = ? AND task_id = ?').get(run, id));
    });
  }

  finishTask(run, id, result, claim) {
    run = requireString(run, 'run');
    id = requireString(id, 'task id');
    if (claim !== undefined && (!Number.isSafeInteger(claim) || claim < 1)) {
      throw new TypeError('claim must be a positive safe integer');
    }
    const serialized = canonicalJsonValue(result, 'result');
    return this.#transaction(() => {
      const row = this.#db.prepare('SELECT * FROM run_tasks WHERE run_id = ? AND task_id = ?').get(run, id);
      if (!row) throw new Error(`unknown task ${id} in run ${run}`);
      if (['blocked', 'promoted', 'refused'].includes(row.status)) {
        if (row.status !== 'blocked' && claim !== row.claim) {
          throw new Error(`claim ${String(claim)} is not current for task ${id}`);
        }
        if (row.status === 'blocked' && claim !== undefined) {
          throw new Error(`blocked task ${id} does not accept a claim`);
        }
        if (row.result_set === 1 && row.result === serialized) return taskFromRow(row);
        throw new Error(`task ${id} already finished with a different result`);
      }

      let status = 'blocked';
      if (row.status === 'running') {
        if (claim !== row.claim) throw new Error(`claim ${String(claim)} is not current for task ${id}`);
        status = JSON.parse(serialized)?.status;
        if (!['promoted', 'refused'].includes(status)) {
          throw new TypeError('running task result.status must be promoted or refused');
        }
      } else if (claim !== undefined) {
        throw new Error(`queued task ${id} does not accept a claim`);
      }
      this.#db.prepare(`
        UPDATE run_tasks SET status = ?, result = ?, result_set = 1
        WHERE run_id = ? AND task_id = ?
      `).run(status, serialized, run, id);
      return taskFromRow(this.#db.prepare('SELECT * FROM run_tasks WHERE run_id = ? AND task_id = ?').get(run, id));
    });
  }

  requeueTask(run, id) {
    run = requireString(run, 'run');
    id = requireString(id, 'task id');
    return this.#transaction(() => {
      const row = this.#db.prepare('SELECT * FROM run_tasks WHERE run_id = ? AND task_id = ?').get(run, id);
      if (!row) throw new Error(`unknown task ${id} in run ${run}`);
      if (row.status !== 'running') throw new Error(`task ${id} is ${row.status}, not running`);
      const operation = this.#db.prepare(`
        SELECT id, status FROM operations
        WHERE json_extract(receipt, '$.runId') = ?
          AND json_extract(receipt, '$.task.contract.id') = ?
          AND status IN ('prepared', 'promoted')
        ORDER BY rowid DESC
        LIMIT 1
      `).get(run, id);
      if (operation) {
        throw new Error(`cannot requeue task ${id} while operation ${operation.id} is ${operation.status}`);
      }
      this.#db.prepare(`
        UPDATE attempts SET active = 0 WHERE run_id = ? AND task_id = ? AND claim = ?
      `).run(run, id, row.claim);
      this.#db.prepare(`
        UPDATE run_tasks SET status = 'queued', result = NULL, result_set = 0
        WHERE run_id = ? AND task_id = ?
      `).run(run, id);
      return taskFromRow(this.#db.prepare('SELECT * FROM run_tasks WHERE run_id = ? AND task_id = ?').get(run, id));
    });
  }
}
