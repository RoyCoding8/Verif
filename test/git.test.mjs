import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { after, test } from 'node:test';
import { GitRepo } from '../src/git.mjs';

const tmp = path.resolve('tmp', `git-tests-${process.pid}`);
fs.mkdirSync(tmp, { recursive: true });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function git(cwd, ...args) {
  const options = args.at(-1)?.inputBuffer !== undefined ? args.pop() : {};
  const input = options.inputBuffer;
  const output = execFileSync('git', ['-C', cwd, ...args], {
    encoding: input === undefined ? 'utf8' : undefined, input, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(cwd, '.git', 'verity-empty-config') },
  });
  return Buffer.isBuffer(output) ? output : output.trim();
}

function repo(name) {
  const root = path.join(tmp, name);
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '--quiet', '--initial-branch=main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@invalid');
  return root;
}

function commit(root, message) {
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

test('reads and updates refs with compare-and-swap', () => {
  const root = repo('cas');
  fs.writeFileSync(path.join(root, 'a'), 'one');
  const first = commit(root, 'first');
  fs.writeFileSync(path.join(root, 'a'), 'two');
  const second = commit(root, 'second');
  const adapter = new GitRepo(root);
  assert.equal(adapter.readRef('refs/heads/verity'), null);
  adapter.updateRef('refs/heads/verity', first, null);
  assert.equal(adapter.readRef('refs/heads/verity'), first);
  assert.throws(() => adapter.updateRef('refs/heads/verity', second, null));
  adapter.updateRef('refs/heads/verity', second, first);
  assert.equal(adapter.readRef('refs/heads/verity'), second);
  assert.throws(() => adapter.updateRef('refs/heads/-option', second, first));
});

test('reports sorted paths and materializes exact blob bytes and executable modes', () => {
  const root = repo('materialize');
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'nested', 'run.sh'), Buffer.from([0, 255, 10]));
  fs.writeFileSync(path.join(root, 'z.txt'), 'z');
  git(root, 'add', '-A');
  git(root, 'update-index', '--chmod=+x', 'nested/run.sh');
  const base = commit(root, 'base');
  fs.writeFileSync(path.join(root, 'z.txt'), 'updated');
  fs.writeFileSync(path.join(root, 'a.txt'), 'new');
  const candidate = commit(root, 'candidate');
  const adapter = new GitRepo(root);
  assert.deepEqual(adapter.changedPaths(base, candidate), ['a.txt', 'z.txt']);
  const destination = path.join(tmp, 'out');
  const materialized = adapter.materialize(base, destination);
  assert.deepEqual(materialized.files.map(({ path: file, mode }) => [file, mode]), [
    ['nested/run.sh', '100755'], ['z.txt', '100644'],
  ]);
  const bytes = fs.readFileSync(path.join(destination, 'nested', 'run.sh'));
  assert.deepEqual(bytes, Buffer.from([0, 255, 10]));
  assert.equal(materialized.files[0].digest, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(materialized.tree, adapter.tree(base));
});

test('forks without a remote, captures changed workspace bytes, and creates a promotion commit', () => {
  const root = repo('controller');
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base');
  const base = commit(root, 'base');
  const adapter = new GitRepo(root);
  const candidatePath = path.join(tmp, 'candidate');
  const candidate = adapter.fork(base, candidatePath);
  assert.equal(git(candidatePath, 'remote').trim(), '');
  assert.equal(git(candidatePath, 'rev-parse', 'HEAD'), base);
  fs.writeFileSync(path.join(candidatePath, 'tracked.txt'), 'worker edit');
  fs.writeFileSync(path.join(candidatePath, 'new.txt'), 'new file');
  const captured = adapter.capture(candidatePath, base);
  assert.deepEqual(adapter.changedPaths(base, captured), ['new.txt', 'tracked.txt']);
  const promotion = adapter.promotionCommit({
    tree: adapter.tree(captured), parent: base, operation: 'promote-42', receipt: 'a'.repeat(64),
  });
  assert.equal(adapter.tree(promotion), adapter.tree(captured));
  assert.equal(git(root, 'show', '-s', '--format=%B', promotion).includes('Operation: promote-42'), true);
  assert.equal(git(root, 'show', '-s', '--format=%B', promotion).includes(`Receipt: ${'a'.repeat(64)}`), true);
  assert.throws(() => adapter.promotionCommit({ tree: adapter.tree(captured), parent: base, operation: 'bad', receipt: 'short' }));
});

test('merges disjoint candidate changes and refuses conflicts', () => {
  const root = repo('integration');
  fs.writeFileSync(path.join(root, 'shared.txt'), 'base\n');
  const base = commit(root, 'base');
  fs.writeFileSync(path.join(root, 'shared.txt'), 'head\n');
  fs.writeFileSync(path.join(root, 'head.txt'), 'head');
  const head = commit(root, 'head');
  git(root, 'checkout', '--quiet', '-b', 'candidate', base);
  fs.writeFileSync(path.join(root, 'candidate.txt'), 'candidate');
  const candidate = commit(root, 'candidate');
  const adapter = new GitRepo(root);
  const tree = adapter.integrationTree(head, candidate);
  assert.match(tree, /^[0-9a-f]{40}$|^[0-9a-f]{64}$/);
  git(root, 'checkout', '--quiet', '-b', 'conflict', base);
  fs.writeFileSync(path.join(root, 'shared.txt'), 'conflict\n');
  const conflict = commit(root, 'conflict');
  assert.throws(() => adapter.integrationTree(head, conflict));
});

test('rejects symlink tree entries and an occupied materialization target', () => {
  const root = repo('unsupported');
  fs.writeFileSync(path.join(root, 'target'), 'target');
  const base = commit(root, 'base');
  const linkBlob = git(root, 'hash-object', '-w', '--stdin', { inputBuffer: Buffer.from('target') }).toString().trim();
  git(root, 'update-index', '--add', '--cacheinfo', `120000,${linkBlob},link`);
  const symlinkTree = git(root, 'write-tree');
  const symlinkCommit = git(root, 'commit-tree', symlinkTree, '-p', base, '-m', 'symlink');
  const adapter = new GitRepo(root);
  assert.throws(() => adapter.materialize(symlinkCommit, path.join(tmp, 'symlink-out')), /Unsupported Git entry symlink/);
  assert.throws(() => adapter.materialize(base, path.join(root, '.git', 'escaped')), /overlaps Git metadata/);
  const occupied = path.join(tmp, 'occupied');
  fs.mkdirSync(occupied);
  fs.writeFileSync(path.join(occupied, 'keep'), 'keep');
  assert.throws(() => adapter.materialize(base, occupied), /must not exist/);
});
