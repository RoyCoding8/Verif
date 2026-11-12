import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { runTasks } from '../src/verity.mjs';
import { createDemo, fixtureWorker } from './setup.mjs';

const scratch = resolve('tmp');
await mkdir(scratch, { recursive: true });
const root = await mkdtemp(join(scratch, 'verity-demo-'));
try {
  const settings = await createDemo(root);
  const results = await runTasks(process.argv.includes('--pi') ? settings : { ...settings, worker: fixtureWorker });
  console.log(JSON.stringify(results, null, 2));
  if (results.some(result => result.status !== 'promoted')) process.exitCode = 1;
} finally {
  if (process.exitCode) console.error('Demo files are available at ' + root);
  else await rm(root, { recursive: true, force: true });
}
