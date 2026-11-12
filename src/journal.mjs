import { DatabaseSync } from 'node:sqlite';

const fields = ['id', 'attempt', 'contract', 'policy', 'ref', 'old', 'next'];

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('receipt must be a JSON object');
  }
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('receipt must be JSON serializable');
  const parsed = JSON.parse(json);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('receipt must serialize to a JSON object');
  }
  const sort = item => Array.isArray(item)
    ? item.map(sort)
    : item && typeof item === 'object'
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])]))
      : item;
  return JSON.stringify(sort(parsed));
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
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY,
        contract TEXT NOT NULL,
        policy TEXT NOT NULL,
        active INTEGER NOT NULL CHECK (active IN (0, 1))
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
    `);
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

  registerAttempt({ id, contract, policy }) {
    id = requireString(id, 'id');
    contract = requireString(contract, 'contract');
    policy = requireString(policy, 'policy');
    return this.#transaction(() => {
      const existing = this.#db.prepare('SELECT * FROM attempts WHERE id = ?').get(id);
      if (existing) {
        if (existing.contract !== contract || existing.policy !== policy) {
          throw new Error(`attempt ${id} is already registered with different authority`);
        }
        return this.authority(id);
      }
      this.#db.prepare('INSERT INTO attempts (id, contract, policy, active) VALUES (?, ?, ?, 1)')
        .run(id, contract, policy);
      return this.authority(id);
    });
  }

  authority(id) {
    id = requireString(id, 'id');
    const row = this.#db.prepare('SELECT id, contract, policy, active FROM attempts WHERE id = ?').get(id);
    return row ? { id: row.id, contract: row.contract, policy: row.policy, active: row.active === 1 } : null;
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
}
