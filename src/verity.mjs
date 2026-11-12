import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { approvedTask, digest, requireThat, within } from './contracts.mjs';
import { GitRepo } from './git.mjs';
import { Journal } from './journal.mjs';
import { runPiWorker } from './pi-worker.mjs';
import { checkFeedback, decide, subjectFor, verify } from './verify.mjs';

class Refusal extends Error {}
class RecoveryRequired extends Error {}

function runIdentity(repository, tasks) {
  const approvals = tasks.map(task => [task.contract.id, task.approval]).sort(([left], [right]) => left.localeCompare(right));
  return digest({ repository, approvals });
}

function promotionResult(op) {
  return {
    id: op.receipt.task.contract.id, status: 'promoted', attempt: op.attempt,
    operation: op.id, commit: op.next, assurance: op.receipt.evidence.assurance,
  };
}

function validateGraph(tasks) {
  const remaining = new Map();
  for (const task of tasks) {
    requireThat(!remaining.has(task.contract.id), 'Duplicate task ' + task.contract.id);
    remaining.set(task.contract.id, new Set(task.contract.dependencies));
  }
  for (const [id, dependencies] of remaining) {
    for (const dependency of dependencies) requireThat(remaining.has(dependency), 'Unknown dependency ' + dependency + ' for ' + id);
  }
  while (remaining.size) {
    const ready = [...remaining].filter(([, dependencies]) => dependencies.size === 0).map(([id]) => id);
    requireThat(ready.length > 0, 'Cyclic task dependencies');
    for (const id of ready) {
      remaining.delete(id);
      for (const dependencies of remaining.values()) dependencies.delete(id);
    }
  }
}

function enforceScope(paths, scope) {
  requireThat(paths.length > 0 && paths.every(path => within(path, scope.write) && !within(path, scope.forbidden)),
    'Candidate has no changes or changed paths outside approved scope');
}

function applyPrepared(journal, repo, id, signal) {
  return journal.promote(id, {
    readRef: ref => repo.readRef(ref),
    updateRef: (ref, next, old) => repo.updateRef(ref, next, old, id),
    recheck: op => {
      signal?.throwIfAborted();
      const { task, evidence, base, original, candidate, deadline } = op.receipt;
      if (task.contract.policy.ref !== op.ref) throw new Refusal('Promotion ref differs from approved policy');
      const changedPaths = repo.changedPaths(op.old, op.next);
      const originalPaths = repo.changedPaths(base, original);
      if (digest(changedPaths) !== digest(originalPaths)) throw new Refusal('Integration changed the approved path set');
      if (repo.tree(candidate) !== repo.tree(op.next)) throw new Refusal('Promotion tree differs from the checked tree');
      const subjects = new Set(task.plan.obligations.map(o => subjectFor(o, base, candidate)));
      const manifests = new Map([...subjects].map(subject => [subject, repo.manifest(subject === candidate ? op.next : subject)]));
      const decision = decide({
        task, receipt: evidence, authority: journal.authority(op.attempt), base, candidate,
        manifests, changedPaths, now: Date.now(), deadline,
      });
      if (!decision.promote) throw new Refusal(decision.reason);
      return true;
    },
  });
}

export function recoverOperation({ repository, journalPath, operation, abandon = false }) {
  const identity = realpathSync(resolve(repository));
  const repo = new GitRepo(identity);
  const journal = new Journal(resolve(journalPath));
  try {
    const prepared = journal.getOperation(operation);
    requireThat(prepared?.receipt.repository === identity, 'Operation does not belong to this repository');
    const op = abandon ? journal.abandon(operation, { readRef: ref => repo.readRef(ref) }) : applyPrepared(journal, repo, operation);
    if (op.status === 'promoted') {
      journal.finishTask(op.receipt.runId, op.receipt.task.contract.id, promotionResult(op), op.receipt.claim);
    }
    return op;
  } finally {
    journal.close();
  }
}

export function inspectRun({ repository, journalPath, tasks: inputs, requeue }) {
  const identity = realpathSync(resolve(repository));
  const tasks = inputs.map(approvedTask);
  const runId = runIdentity(identity, tasks);
  const journal = new Journal(resolve(journalPath));
  try {
    if (requeue) {
      const task = tasks.find(task => task.contract.id === requeue);
      requireThat(task, 'Unknown task ' + requeue);
      requireThat(!journal.getTaskPromotion(runId, requeue), 'Task already promoted. Run again to reconcile its status.');
      const pending = journal.getPending(task.contract.policy.ref);
      requireThat(!pending, 'Recover prepared operation ' + pending?.id + ' before requeueing');
      journal.requeueTask(runId, requeue);
    }
    return { runId, tasks: journal.runTasks(runId) };
  } finally {
    journal.close();
  }
}

async function integrate(context, task, claim, attempt, base, original, deadline, signal) {
  const { repo, repository, runId, journal, oracleRoot, scratch } = context;
  const { contract } = task;
  const { ref } = contract.policy;
  const originalPaths = repo.changedPaths(base, original);
  enforceScope(originalPaths, contract.scope);
  for (let round = 0; round < 4; round++) {
    signal.throwIfAborted();
    const head = repo.readRef(ref);
    requireThat(head, 'Protected ref does not exist: ' + ref);
    const operation = randomUUID();
    const tree = head === base ? repo.tree(original) : repo.integrationTree(head, original);
    const candidate = head === base ? original : repo.promotionCommit({
      tree, parent: head, operation, receipt: digest({ operation, tree, head }),
    });
    const paths = repo.changedPaths(head, candidate);
    requireThat(digest(paths) === digest(originalPaths), 'Integration changed the approved path set');
    const evidence = await verify({ repo, task, base, candidate, oracleRoot, scratch, signal, deadline });
    if (repo.readRef(ref) !== head) continue;
    signal.throwIfAborted();
    const bundle = { repository, runId, claim, task, evidence, base, original, candidate, deadline };
    const next = repo.promotionCommit({ tree, parent: head, operation, receipt: digest(bundle) });
    journal.prepare({
      id: operation, attempt, contract: task.approval, policy: digest(contract.policy),
      ref, old: head, next, receipt: bundle,
    });
    try {
      return promotionResult(applyPrepared(journal, repo, operation, signal));
    } catch (error) {
      const current = repo.readRef(ref);
      if (current === next) throw new RecoveryRequired('Promotion requires recovery for operation ' + operation, { cause: error });
      const authority = journal.authority(attempt);
      if (current !== head || signal.aborted || error instanceof Refusal ||
        !authority?.active || authority.policy !== digest(contract.policy)) {
        journal.abandon(operation, { readRef: name => repo.readRef(name) });
        if (current !== head && !signal.aborted) continue;
        throw error;
      }
      throw new RecoveryRequired('Prepared operation requires recovery: ' + operation, { cause: error });
    }
  }
  throw new Refusal('Protected head kept moving during verification');
}

async function runTask(context, task, { claim, startedMs }) {
  const { repo, runId, journal, worker, signal: cancellation, oracleRoot, scratch, onEvent } = context;
  const { contract } = task;
  const deadline = startedMs + contract.policy.budgetMs;
  const remaining = deadline - Date.now();
  requireThat(remaining > 0, 'Task budget expired');
  const timer = AbortSignal.timeout(remaining);
  const signal = cancellation ? AbortSignal.any([timer, cancellation]) : timer;
  const repairs = contract.policy.maxRepairs ?? 0;
  let diagnosis = '';
  for (let round = 0; round <= repairs; round++) {
    signal.throwIfAborted();
    const attempt = randomUUID();
    const observedHead = repo.readRef(contract.policy.ref);
    requireThat(observedHead, 'Protected ref does not exist');
    const base = contract.base === 'head-at-dispatch' ? observedHead : contract.base;
    journal.registerAttempt({ id: attempt, contract: task.approval, policy: digest(contract.policy), runId, taskId: contract.id, claim });
    let temporary;
    let checking = false;
    try {
      onEvent?.({ type: 'attempt_started', runId, task: contract.id, attempt });
      temporary = await mkdtemp(join(scratch, 'attempt-'));
      const workspace = join(temporary, 'worker');
      repo.fork(base, workspace);
      await worker({
        workspace, goal: contract.goal + diagnosis, scope: contract.scope, signal,
        approvedChecks: task.plan.obligations.map(obligation => obligation.id),
        runCheck: async (name, options) => {
          requireThat(!checking, 'A feedback check is already running');
          requireThat(task.plan.obligations.some(o => o.id === name), 'Unknown approved check ' + name);
          checking = true;
          try {
            const snapshot = repo.capture(workspace, base);
            const checkSignal = options?.signal ? AbortSignal.any([signal, options.signal]) : signal;
            return await checkFeedback({
              repo, task, name, base, candidate: snapshot, oracleRoot, scratch, signal: checkSignal, deadline,
            });
          } catch (error) {
            return 'Feedback failed: ' + error.message;
          } finally {
            checking = false;
          }
        },
      });
      signal.throwIfAborted();
      const candidate = repo.capture(workspace, base);
      return await integrate(context, task, claim, attempt, base, candidate, deadline, signal);
    } catch (error) {
      if (round === repairs || signal.aborted || error instanceof RecoveryRequired || !journal.authority(attempt)?.active) throw error;
      diagnosis = '\nPrevious attempt was refused: ' + error.message;
    } finally {
      journal.invalidate(attempt);
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  }
}

export async function runTasks({
  repository, journalPath, oracleRoot, scratch, tasks: inputs, maxWorkers = 2, worker = runPiWorker, signal, onEvent,
}) {
  requireThat(Array.isArray(inputs) && inputs.length > 0, 'No tasks supplied');
  requireThat(Number.isSafeInteger(maxWorkers) && maxWorkers > 0 && maxWorkers <= 32, 'Invalid worker limit');
  const tasks = inputs.map(approvedTask);
  validateGraph(tasks);
  repository = realpathSync(resolve(repository));
  const repo = new GitRepo(repository);
  const runId = runIdentity(repository, tasks);
  scratch = resolve(scratch);
  await mkdir(scratch, { recursive: true });
  const database = resolve(journalPath);
  await mkdir(dirname(database), { recursive: true });
  const journal = new Journal(database);
  const context = { repo, repository, runId, journal, oracleRoot: resolve(oracleRoot), scratch, worker, signal, onEvent };
  const byId = new Map(tasks.map(task => [task.contract.id, task]));
  const pending = new Map();
  const running = new Map();
  const completed = new Map();
  try {
    for (const ref of new Set(tasks.map(task => task.contract.policy.ref))) {
      const operation = journal.getPending(ref);
      requireThat(!operation, 'Recover prepared operation ' + operation?.id + ' before running tasks for ' + ref);
    }
    journal.registerRun(runId, tasks.map(task => ({ id: task.contract.id, approval: task.approval })));
    for (const record of journal.runTasks(runId)) {
      if (record.status === 'running') {
        const op = journal.getTaskPromotion(runId, record.id);
        requireThat(op, 'Task ' + record.id + ' is already running. Requeue it if its controller has stopped.');
        const result = promotionResult(op);
        journal.finishTask(runId, record.id, result, record.claim);
        completed.set(record.id, result);
      } else if (record.status === 'queued') {
        pending.set(record.id, byId.get(record.id));
      } else {
        completed.set(record.id, record.result);
      }
    }
    while (pending.size || running.size) {
      for (const [id, task] of pending) {
        if (running.size === maxWorkers) break;
        if (!task.contract.dependencies.every(dependency => completed.has(dependency))) continue;
        pending.delete(id);
        if (task.contract.dependencies.some(dependency => completed.get(dependency).status !== 'promoted')) {
          const result = { id, status: 'blocked', reason: 'Prerequisite was not promoted' };
          journal.finishTask(runId, id, result);
          completed.set(id, result);
          continue;
        }
        const claim = journal.startTask(runId, id);
        running.set(id, runTask(context, task, claim).catch(error => {
          if (error instanceof RecoveryRequired) throw error;
          return { id, status: 'refused', reason: error.message };
        }).then(result => {
          journal.finishTask(runId, id, result, claim.claim);
          return result;
        }));
      }
      if (running.size) {
        const result = await Promise.race(running.values());
        running.delete(result.id);
        completed.set(result.id, result);
      }
    }
    return tasks.map(task => completed.get(task.contract.id));
  } finally {
    await Promise.allSettled(running.values());
    journal.close();
  }
}
