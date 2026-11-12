import { DatabaseSync } from 'node:sqlite';

const fields = ['id', 'attempt', 'contract', 'policy', 'ref', 'old', 'next'];

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
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
      CREATE TABLE IF NOT EXISTS run_tasks (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,
        approval TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'blocked', 'promoted', 'refused')),
        claim INTEGER NOT NULL DEFAULT 0 CHECK (claim >= 0),
        started_ms INTEGER,
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
    const taskColumns = new Set(this.#db.prepare('PRAGMA table_info(run_tasks)').all().map(column => column.name));
    if (!taskColumns.has('claim')) {
      this.#db.exec('ALTER TABLE run_tasks ADD COLUMN claim INTEGER NOT NULL DEFAULT 0 CHECK (claim >= 0)');
    }
    if (!taskColumns.has('started_ms')) this.#db.exec('ALTER TABLE run_tasks ADD COLUMN started_ms INTEGER');
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
        const task = this.#db.prepare('SELECT status, claim, approval FROM run_tasks WHERE run_id = ? AND task_id = ?')
          .get(runId, taskId);
        if (!task || task.status !== 'running' || task.claim !== claim ||
            task.approval !== canonicalJsonValue(contract, 'contract')) {
          throw new Error(`task ${taskId} in run ${runId} does not authorize contract ${contract} at claim ${claim}`);
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
    let active = row.active === 1;
    if (active && row.run_id !== null) {
      const task = this.#db.prepare('SELECT status, claim FROM run_tasks WHERE run_id = ? AND task_id = ?')
        .get(row.run_id, row.task_id);
      active = !!task && task.status === 'running' && task.claim === row.claim;
    }
    return { id: row.id, contract: row.contract, policy: row.policy, active };
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
      return {
        id: requireString(task.id, 'task id'),
        approval: canonicalJsonValue(task.approval, 'approval'),
      };
    });
    if (new Set(entries.map(task => task.id)).size !== entries.length) {
      throw new Error('task ids must be unique within a run');
    }

    return this.#transaction(() => {
      const existing = this.#db.prepare('SELECT id FROM runs WHERE id = ?').get(id);
      if (existing) {
        const stored = this.#db.prepare(
          'SELECT task_id, approval FROM run_tasks WHERE run_id = ? ORDER BY task_id',
        ).all(id);
        const approvals = new Map(stored.map(row => [row.task_id, row.approval]));
        if (stored.length !== entries.length || entries.some(task => approvals.get(task.id) !== task.approval)) {
          throw new Error(`run ${id} was already registered with a different task set`);
        }
        return this.runTasks(id);
      }

      this.#db.prepare('INSERT INTO runs (id) VALUES (?)').run(id);
      const insert = this.#db.prepare(`
        INSERT INTO run_tasks (run_id, task_id, approval, status, claim, started_ms, result, result_set)
        VALUES (?, ?, ?, 'queued', 0, NULL, NULL, 0)
      `);
      for (const task of entries) insert.run(id, task.id, task.approval);
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
