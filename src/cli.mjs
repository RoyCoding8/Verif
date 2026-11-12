#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { digest, makeContract, planVerification, requireThat } from './contracts.mjs';
import { Journal } from './journal.mjs';
import { proposeTask } from './planner.mjs';
import { inspectRun, recoverOperation, runTasks } from './verity.mjs';

const usage = 'Usage: verity propose <manifest> | plan <manifest> | run <manifest> | status <manifest> | requeue <manifest> <task> | receipt <manifest> <operation> | cancel <manifest> <attempt> | recover <manifest> <operation> [--abandon]';

async function main() {
  const [command, filename, id, option, ...rest] = process.argv.slice(2);
  if (command === '--help' || command === '-h') {
    console.log(usage);
    return;
  }
  requireThat(filename && ['propose', 'plan', 'run', 'status', 'requeue', 'receipt', 'cancel', 'recover'].includes(command) && !rest.length, usage);
  requireThat(['propose', 'plan', 'run', 'status'].includes(command) ? !id : id, usage);
  requireThat(option === undefined || (command === 'recover' && option === '--abandon'), usage);
  const manifest = JSON.parse(await readFile(filename, 'utf8'));
  if (command === 'plan') {
    requireThat(Array.isArray(manifest.tasks) && manifest.tasks.length > 0, 'Missing tasks');
    return manifest.tasks.map(task => {
      const plan = planVerification(task);
      const contract = makeContract(task, plan);
      return { id: contract.id, approval: digest(contract), contract, plan };
    });
  }
  const directory = dirname(resolve(filename));
  const settings = {
    repository: resolve(directory, manifest.repository),
    journalPath: resolve(directory, manifest.journal ?? '.verity/journal.sqlite'),
    oracleRoot: resolve(directory, manifest.oracles ?? 'oracles'),
    scratch: resolve(directory, manifest.scratch ?? '.verity'),
    tasks: manifest.tasks,
    maxWorkers: manifest.maxWorkers,
  };
  if (command === 'propose') {
    requireThat(Array.isArray(manifest.tasks) && manifest.tasks.length > 0, 'Missing tasks');
    const proposals = [];
    for (const draft of manifest.tasks) proposals.push(await proposeTask({ ...settings, draft }));
    return proposals;
  }
  if (command === 'run') {
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort(new Error('Interrupted')));
    const results = await runTasks({
      ...settings, signal: controller.signal,
      onEvent: event => console.error(JSON.stringify(event)),
    });
    if (results.some(result => result.status !== 'promoted')) process.exitCode = 1;
    return results;
  }
  if (command === 'status' || command === 'requeue') return inspectRun({ ...settings, requeue: id });
  if (command === 'recover') return recoverOperation({ ...settings, operation: id, abandon: option === '--abandon' });
  const journal = new Journal(settings.journalPath);
  try {
    if (command === 'cancel') {
      journal.invalidate(id);
      return journal.authority(id);
    }
    const operation = journal.getOperation(id);
    requireThat(operation, 'Unknown operation ' + id);
    return operation;
  } finally {
    journal.close();
  }
}

try {
  const result = await main();
  if (result !== undefined) console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
