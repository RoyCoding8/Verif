import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

function jsonOutput(output, label) {
  const json = JSON.stringify(output);
  const value = json === undefined ? undefined : JSON.parse(json);
  if (json === undefined || !isDeepStrictEqual(output, value)) throw new Error('Operation output must be JSON: ' + label);
  return value;
}

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
        call.output = jsonOutput(output, operation);
      };
      const result = service[operation](input);
      finish(result != null && typeof result.then === 'function' ? await result : result);
    });
    await Promise.all(pending);
  }
  return history;
}

const [workspace, request, mode] = process.argv.slice(2);
const strictJson = mode === '--strict-json';
const cases = JSON.parse(await readFile(request, 'utf8'));
const observations = [];
for (const { id, module, name, args, calls } of cases) {
  const exports = await import(pathToFileURL(join(workspace, module)));
  if (typeof exports[name] !== 'function') throw new Error('Required export is missing: ' + name);
  const output = calls ? await captureHistory(exports[name], args, calls) : await exports[name](...args);
  observations.push({ id, actual: strictJson && !calls ? jsonOutput(output, name) : output });
}
process.stdout.write(JSON.stringify(observations));
