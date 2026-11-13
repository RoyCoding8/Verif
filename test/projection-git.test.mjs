import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { after, test } from 'node:test';
import { GitRepo } from '../src/git.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-projection-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function git(cwd, ...args) {
  const inputBuffer = args.at(-1)?.inputBuffer;
  if (inputBuffer !== undefined) args.pop();
  const output = execFileSync('git', ['-C', cwd, ...args], {
    encoding: inputBuffer === undefined ? 'utf8' : undefined,
    input: inputBuffer,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(cwd, '.git', 'empty-config') },
  });
  return Buffer.isBuffer(output) ? output : output.trim();
}

function makeRepo(name) {
  const root = path.join(tmp, name);
  fs.mkdirSync(root);
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

function listFiles(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listFiles(path.join(directory, entry.name), file) : [file];
  }).sort();
}

test('materializes every nonempty exact path projection with matching bytes and modes', () => {
  const root = makeRepo('finite');
  const source = new Map([
    ['alpha.txt', { bytes: Buffer.from('alpha\0bytes'), mode: '100644' }],
    ['nested/run.sh', { bytes: Buffer.from('#!/bin/sh\nexit 0\n'), mode: '100755' }],
    ['nested/zeta.bin', { bytes: Buffer.from([0, 255, 3]), mode: '100644' }],
    ['z-last.txt', { bytes: Buffer.from('last'), mode: '100644' }],
  ]);
  for (const [file, { bytes, mode }] of source) {
    const absolute = path.join(root, ...file.split('/'));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, bytes);
    fs.chmodSync(absolute, mode === '100755' ? 0o755 : 0o644);
  }
  git(root, 'add', '-A');
  git(root, 'update-index', '--chmod=+x', 'nested/run.sh');
  const head = commit(root, 'finite fixture');
  const adapter = new GitRepo(root);
  const full = adapter.manifest(head);
  const files = [...source.keys()].sort();

  for (let mask = 1; mask < 1 << files.length; mask++) {
    const selected = files.filter((_, index) => mask & (1 << index));
    const destination = path.join(tmp, `projection-${mask}`);
    const projection = adapter.materialize(head, destination, selected);
    const expected = full.files.filter(({ path: file }) => selected.includes(file));
    assert.equal(projection.tree, full.tree);
    assert.deepEqual(projection.files, expected);
    assert.deepEqual(projection.files.map(({ path: file }) => file), selected);
    assert.deepEqual(listFiles(destination), selected.slice().sort());
    for (const { path: file, mode } of expected) {
      const actualPath = path.join(destination, ...file.split('/'));
      assert.deepEqual(fs.readFileSync(actualPath), source.get(file).bytes);
      if (process.platform !== 'win32') assert.equal(fs.statSync(actualPath).mode & 0o111 ? '100755' : '100644', mode);
    }
  }
});

test('rejects malformed, duplicate, missing, and pathspec-like selections before changing destination', () => {
  const root = makeRepo('invalid');
  fs.writeFileSync(path.join(root, 'present.txt'), 'present');
  const head = commit(root, 'invalid fixture');
  const adapter = new GitRepo(root);
  const cases = [
    { selection: [], error: /nonempty array/ },
    { selection: 'present.txt', error: /nonempty array/ },
    { selection: [null], error: /nonempty array/ },
    { selection: ['present.txt', 'present.txt'], error: /duplicate paths/ },
    { selection: ['missing.txt'], error: /missing paths/ },
    { selection: ['*.txt'], error: /Unsafe|Non-portable/ },
    { selection: ['PRESENT.txt'], error: /missing paths/ },
  ];
  for (const [index, { selection, error }] of cases.entries()) {
    const destination = path.join(tmp, `invalid-${index}`);
    assert.throws(() => adapter.materialize(head, destination, selection), error);
    assert.equal(fs.existsSync(destination), false);
  }

  const emptyDestination = path.join(tmp, 'existing-empty');
  fs.mkdirSync(emptyDestination);
  assert.throws(() => adapter.materialize(head, emptyDestination, ['missing.txt']), /missing paths/);
  assert.deepEqual(fs.readdirSync(emptyDestination), []);
});

test('rejects unsupported modes in the selected file and retains whole-tree mode validation', () => {
  const root = makeRepo('unsupported');
  fs.writeFileSync(path.join(root, 'supported.txt'), 'supported');
  const base = commit(root, 'supported base');
  const linkBlob = git(root, 'hash-object', '-w', '--stdin', { inputBuffer: Buffer.from('supported.txt') }).toString().trim();
  git(root, 'update-index', '--add', '--cacheinfo', `120000,${linkBlob},link`);
  const tree = git(root, 'write-tree');
  const unsupported = git(root, 'commit-tree', tree, '-p', base, '-m', 'symlink fixture');
  const adapter = new GitRepo(root);
  const destination = path.join(tmp, 'unsupported-out');
  assert.throws(() => adapter.materialize(unsupported, destination, ['link']), /Unsupported Git entry symlink/);
  assert.equal(fs.existsSync(destination), false);
  assert.throws(() => adapter.materialize(unsupported, destination, ['supported.txt']), /Unsupported Git entry symlink/);
  assert.equal(fs.existsSync(destination), false);
});
