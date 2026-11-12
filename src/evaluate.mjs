import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [workspace, request] = process.argv.slice(2);
const cases = JSON.parse(await readFile(request, 'utf8'));
const observations = [];
for (const { id, module, name, args } of cases) {
  const exports = await import(pathToFileURL(join(workspace, module)));
  if (typeof exports[name] !== 'function') throw new Error('Required export is missing: ' + name);
  const actual = await exports[name](...args);
  observations.push({ id, actual });
}
process.stdout.write(JSON.stringify(observations));
