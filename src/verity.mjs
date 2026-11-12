import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { approvedTask, digest, requireThat, within } from './contracts.mjs';
import { GitRepo } from './git.mjs';
import { Journal } from './journal.mjs';
import { runPiWorker } from './pi-worker.mjs';
import { decide, subjectFor, verify } from './verify.mjs';

class Refusal extends Error {}

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
    updateRef: (ref, next, old) => repo.updateRef(ref, next, old),
    recheck: op => {
      signal?.throwIfAborted();
      const { task, evidence, base, original, candidate, deadline } = op.receipt;
      if (task.contract.policy.ref !== op.ref) throw new Refusal('Promotion ref differs from approved policy');
      const changedPaths = repo.changedPaths(op.old, op.next);
      const originalPaths = repo.changedPaths(base, original);
      if (digest(changedPaths) !== digest(originalPaths)) throw new Refusal('Integration changed the approved path set');
      if (repo.tree(candidate) !== repo.tree(op.next)) throw new Refusal('Promotion tree differs from the checked tree');
      const subjects = new Set(task.plan.obligations.map(o => subjectFor(o, base, candidate)));
      const trees = new Map([...subjects].map(subject => [subject, repo.tree(subject)]));
      const decision = decide({
        task, receipt: evidence, authority: journal.authority(op.attempt), base, candidate,
        trees, changedPaths, now: Date.now(), deadline,
      });
      if (!decision.promote) throw new Refusal(decision.reason);
      return true;
    },
  });
}

export function recoverOperation({ repository, journalPath, operation, abandon = false }) {
  const repo = new GitRepo(resolve(repository));
  const journal = new Journal(resolve(journalPath));
  try {
    if (abandon) return journal.abandon(operation, { readRef: ref => repo.readRef(ref) });
    return applyPrepared(journal, repo, operation);
  } finally {
    journal.close();
  }
}

async function integrate(context, task, attempt, base, original, deadline, signal) {
  const { repo, journal, oracleRoot, scratch } = context;
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
    const bundle = { task, evidence, base, original, candidate, deadline };
    const next = repo.promotionCommit({ tree, parent: head, operation, receipt: digest(bundle) });
    journal.prepare({
      id: operation, attempt, contract: task.approval, policy: digest(contract.policy),
      ref, old: head, next, receipt: bundle,
    });
    try {
      applyPrepared(journal, repo, operation, signal);
      return { id: contract.id, status: 'promoted', attempt, operation, commit: next, assurance: evidence.assurance };
    } catch (error) {
      const current = repo.readRef(ref);
      if (current === next) throw new Error('Promotion requires recovery for operation ' + operation, { cause: error });
      const authority = journal.authority(attempt);
      if (current !== head || signal.aborted || error instanceof Refusal ||
        !authority?.active || authority.policy !== digest(contract.policy)) {
        journal.abandon(operation, { readRef: name => repo.readRef(name) });
        if (current !== head && !signal.aborted) continue;
        throw error;
      }
      throw new Error('Prepared operation requires recovery: ' + operation, { cause: error });
    }
  }
  throw new Refusal('Protected head kept moving during verification');
}

async function runTask(context, task) {
  const { repo, journal, worker, signal: cancellation, oracleRoot, scratch } = context;
  const { contract } = task;
  const deadline = Date.now() + contract.policy.budgetMs;
  const timer = AbortSignal.timeout(Math.min(contract.policy.budgetMs, 2 ** 32 - 1));
  const signal = cancellation ? AbortSignal.any([timer, cancellation]) : timer;
  const repairs = contract.policy.maxRepairs ?? 0;
  let diagnosis = '';
  for (let round = 0; round <= repairs; round++) {
    signal.throwIfAborted();
    const attempt = randomUUID();
    const observedHead = repo.readRef(contract.policy.ref);
    requireThat(observedHead, 'Protected ref does not exist');
    const base = contract.base === 'head-at-dispatch' ? observedHead : contract.base;
    journal.registerAttempt({ id: attempt, contract: task.approval, policy: digest(contract.policy) });
    const temporary = await mkdtemp(join(scratch, 'attempt-'));
    const workspace = join(temporary, 'worker');
    let checking = false;
    try {
      repo.fork(base, workspace);
      await worker({
        workspace, goal: contract.goal + diagnosis, scope: contract.scope, signal,
        approvedChecks: task.plan.obligations.map(obligation => obligation.id),
        runCheck: async name => {
          requireThat(!checking, 'A feedback check is already running');
          requireThat(task.plan.obligations.some(o => o.id === name), 'Unknown approved check ' + name);
          checking = true;
          try {
            const snapshot = repo.capture(workspace, base);
            const receipt = await verify({ repo, task, base, candidate: snapshot, oracleRoot, scratch, signal, deadline });
            return receipt.results.find(o => o.id === name).status;
          } catch (error) {
            return 'Feedback failed: ' + error.message;
          } finally {
            checking = false;
          }
        },
      });
      signal.throwIfAborted();
      const candidate = repo.capture(workspace, base);
      return await integrate(context, task, attempt, base, candidate, deadline, signal);
    } catch (error) {
      if (round === repairs || signal.aborted || error.message.includes('requires recovery')) throw error;
      diagnosis = '\nPrevious attempt was refused: ' + error.message;
    } finally {
      journal.invalidate(attempt);
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

export async function runTasks({
  repository, journalPath, oracleRoot, scratch, tasks: inputs, maxWorkers = 2, worker = runPiWorker, signal,
}) {
  requireThat(Array.isArray(inputs) && inputs.length > 0, 'No tasks supplied');
  requireThat(Number.isSafeInteger(maxWorkers) && maxWorkers > 0 && maxWorkers <= 32, 'Invalid worker limit');
  const tasks = inputs.map(approvedTask);
  validateGraph(tasks);
  const repo = new GitRepo(resolve(repository));
  scratch = resolve(scratch);
  await mkdir(scratch, { recursive: true });
  const database = resolve(journalPath);
  await mkdir(resolve(database, '..'), { recursive: true });
  const journal = new Journal(database);
  const context = { repo, journal, oracleRoot: resolve(oracleRoot), scratch, worker, signal };
  const pending = new Map(tasks.map(task => [task.contract.id, task]));
  const running = new Map();
  const completed = new Map();
  try {
    for (const ref of new Set(tasks.map(task => task.contract.policy.ref))) {
      const operation = journal.getPending(ref);
      requireThat(!operation, 'Recover prepared operation ' + operation?.id + ' before running tasks for ' + ref);
    }
    while (pending.size || running.size) {
      for (const [id, task] of pending) {
        if (running.size === maxWorkers) break;
        if (!task.contract.dependencies.every(dependency => completed.has(dependency))) continue;
        pending.delete(id);
        if (task.contract.dependencies.some(dependency => completed.get(dependency).status !== 'promoted')) {
          completed.set(id, { id, status: 'blocked', reason: 'Prerequisite was not promoted' });
          continue;
        }
        running.set(id, runTask(context, task).catch(error => ({ id, status: 'refused', reason: error.message })));
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
