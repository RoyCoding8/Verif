import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, hash, makeContract, planVerification } from '../src/contracts.mjs';

const domain = { module: 'reserve.mjs', name: 'reserve', axes: [[0, 1, 2], [-1, 0, 1, 2, 3]] };
const arithmetic = 'Reservation arithmetic preserves stock for rejected quantities and subtracts valid quantities';
const cases = [0, 1, 2].flatMap(stock => [-1, 0, 1, 2, 3].map(quantity => stock + '/' + quantity));
const patches = {
  'reserve.mjs': 'export function reserve(stock, quantity) { return quantity >= 1 && quantity <= stock ? stock - quantity : stock; }\n',
  'response.mjs': "export function response(status) { return status === 'declined' ? 'Reservation declined' : status; }\n",
  'api.mjs': "import { reserve } from './reserve.mjs';\nimport { response } from './response.mjs';\nexport function reserveAndRespond(stock, quantity) {\n  const remaining = reserve(stock, quantity);\n  return { remaining, message: response(remaining === stock ? 'declined' : 'accepted') };\n}\n",
};

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

export function approve(input) {
  const plan = planVerification(input);
  return { ...input, approval: digest(makeContract(input, plan)) };
}

export async function createDemo(root) {
  const repository = join(root, 'repo.git');
  const source = join(root, 'seed');
  const oracleRoot = fileURLToPath(new URL('./oracles/', import.meta.url));
  await mkdir(source);
  git(source, 'init', '-q', '-b', 'protected');
  await writeFile(join(source, 'reserve.mjs'), 'export function reserve(stock, quantity) {\n  if (stock === 0 && quantity === 1) return -1;\n  return quantity >= 1 && quantity <= stock ? stock - quantity : stock;\n}\n');
  await writeFile(join(source, 'response.mjs'), "export function response(status) { return status; }\n");
  await writeFile(join(source, 'api.mjs'), 'export function reserveAndRespond() { return {}; }\n');
  git(source, 'add', '.');
  git(source, '-c', 'user.name=Verity Fixture', '-c', 'user.email=verity@example.invalid', 'commit', '-qm', 'Seed reservation fixture');
  git(root, 'clone', '--bare', '--quiet', source, repository);
  const oracles = Object.fromEntries(await Promise.all(['arithmetic', 'messages', 'api'].map(async name => {
    const file = name + '.json';
    return [name, { file, digest: hash(await readFile(join(oracleRoot, file))) }];
  })));
  const arithmeticClaim = { id: 'stock', statement: arithmetic, required: 'bounded', domain };
  const obligation = (id, claim, oracle, checkCases, options = {}) => ({
    id, claim, oracle, cases: checkCases, subject: 'candidate', expect: 'PASS', timeoutMs: 5000, ...options,
  });
  const stockPass = obligation('stock-after', 'stock', oracles.arithmetic, cases, { outputs: ['cases.json'] });
  const task = (id, goal, file, dependencies, claims, obligations) => approve({
    id, revision: 1, goal, dependencies, claims, obligations,
    criteria: [{ id: 'acceptance', description: goal, claims: claims.map(claim => claim.id) }],
    scope: { read: Object.keys(patches), write: [file], forbidden: [] },
    policy: { ref: 'refs/heads/protected', budgetMs: 45000 },
  });
  return {
    repository, oracleRoot, scratch: join(root, 'scratch'), journalPath: join(root, 'journal.sqlite'),
    maxWorkers: 2,
    tasks: [
      task('reserve', 'Repair reserve.mjs so zero stock cannot underflow.', 'reserve.mjs', [], [arithmeticClaim], [
        obligation('stock-before', 'stock', oracles.arithmetic, cases, { subject: 'base', expect: 'FAIL', witness: '0/1' }),
        stockPass,
      ]),
      task('messages', 'Update response.mjs so declined renders as Reservation declined.', 'response.mjs', [],
        [{ id: 'message', statement: 'Declined reservations use the approved wording', required: 'tested' }],
        [obligation('decline-message', 'message', oracles.messages, ['declined-message'])]),
      task('api', 'Implement reserveAndRespond in api.mjs using reserve and response. Return remaining stock and the response message.',
        'api.mjs', ['reserve', 'messages'], [arithmeticClaim, {
          id: 'api', statement: 'The API preserves stock and reports a declined reservation', required: 'tested', domain,
          dependencies: [{ claim: 'stock', statement: arithmetic }],
        }], [stockPass, obligation('decline-api', 'api', oracles.api, ['declined-reservation'])]),
    ],
  };
}

export async function fixtureWorker({ workspace, scope }) {
  const [file] = scope.write;
  await writeFile(join(workspace, file), patches[file]);
}
