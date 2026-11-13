import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

async function captureHistory(factory, args, phases) {
  const service = await factory(...args);
  let event = 0;
  const history = [];
  for (const calls of phases) {
    const pending = calls.map(async ({ operation, input }) => {
      if (!Object.hasOwn(service, operation) || typeof service[operation] !== 'function') {
        throw new Error('Required operation is missing: ' + operation);
      }
      const call = { operation, input: structuredClone(input), invocation: event++ };
      history.push(call);
      const finish = output => {
        call.response = event++;
        const json = JSON.stringify(output);
        const value = json === undefined ? undefined : JSON.parse(json);
        if (json === undefined || !isDeepStrictEqual(output, value)) {
          throw new Error('Operation output must be JSON: ' + operation);
        }
        call.output = value;
      };
      const result = service[operation](input);
      finish(result != null && typeof result.then === 'function' ? await result : result);
    });
    await Promise.all(pending);
  }
  return history;
}

const [workspace, request] = process.argv.slice(2);
const cases = JSON.parse(await readFile(request, 'utf8'));
const observations = [];
for (const { id, module, name, args, calls } of cases) {
  const exports = await import(pathToFileURL(join(workspace, module)));
  if (typeof exports[name] !== 'function') throw new Error('Required export is missing: ' + name);
  const actual = calls ? await captureHistory(exports[name], args, calls) : await exports[name](...args);
  observations.push({ id, actual });
}
process.stdout.write(JSON.stringify(observations));
