import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function run(cwd, args, input, extraEnv = {}, binaryOutput = false) {
  const globalConfig = path.join(cwd, '.git', `verity-empty-${process.pid}-${crypto.randomUUID()}`);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig,
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...extraEnv };
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key) || [
      'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_COMMON_DIR', 'GIT_CONFIG', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_NAMESPACE', 'GIT_TEMPLATE_DIR',
    ].includes(key)) delete env[key];
  }
  return execFileSync('git', ['-C', cwd, '-c', 'core.hooksPath=', '-c', 'protocol.file.allow=always', ...args], {
    encoding: binaryOutput ? undefined : 'utf8', input, env, stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function gitPath(raw) {
  const value = Buffer.isBuffer(raw) ? new TextDecoder('utf-8', { fatal: true }).decode(raw) : raw;
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') ||
      value.startsWith('/') || /^[a-z]:/i.test(value) || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`Unsafe repository path: ${JSON.stringify(value)}`);
  }
  const segments = value.split('/');
  if (segments.some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' ||
      /[. ]$/.test(part) || /[<>:"|?*]/.test(part) || RESERVED.test(part))) {
    throw new Error(`Non-portable repository path: ${JSON.stringify(value)}`);
  }
  return value;
}

function nulRecords(data) {
  const result = [];
  let start = 0;
  for (let end = 0; end < data.length; end++) {
    if (data[end] === 0) {
      if (end > start) result.push(data.subarray(start, end));
      start = end + 1;
    }
  }
  if (start < data.length) result.push(data.subarray(start));
  return result;
}

function oid(value, label = 'object id') {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function refName(value) {
  if (typeof value !== 'string' || !value.startsWith('refs/heads/') || value.startsWith('-') || value.includes('\0')) {
    throw new Error('Invalid ref');
  }
  try { run(process.cwd(), ['check-ref-format', value]); }
  catch { throw new Error(`Invalid ref: ${value}`); }
  return value;
}

function canonicalRepo(root) {
  const abs = path.resolve(root);
  const requested = fs.realpathSync(abs);
  const isBare = run(abs, ['rev-parse', '--is-bare-repository']).trim() === 'true';
  const repoRoot = isBare ? run(abs, ['rev-parse', '--absolute-git-dir']).trim() : run(abs, ['rev-parse', '--show-toplevel']).trim();
  if (!repoRoot) throw new Error(`Not a Git repository: ${abs}`);
  const canonicalRoot = fs.realpathSync(repoRoot);
  if (canonicalRoot !== requested) throw new Error(`Git repository root does not match requested path: ${abs}`);
  return canonicalRoot;
}

function assertDirectRef(repo, ref) {
  try {
    const target = run(repo, ['symbolic-ref', '--quiet', ref]).trim();
    if (target) throw new Error(`Symbolic branch refs are not supported: ${ref}`);
  } catch (error) {
    if (error.message.startsWith('Symbolic branch refs')) throw error;
    if (error.status !== 1) throw error;
  }
}

function ensureCommit(repo, commit) {
  oid(commit, 'commit id');
  run(repo, ['cat-file', '-e', `${commit}^{commit}`]);
  return commit;
}

function entries(repo, commit) {
  ensureCommit(repo, commit);
  const data = run(repo, ['ls-tree', '-rz', '--full-tree', '-r', commit], undefined, {}, true);
  const result = [];
  const seen = new Set();
  for (const record of nulRecords(data)) {
    const tab = record.indexOf(9);
    if (tab < 0) throw new Error('Malformed Git tree entry');
    const [mode, type, id] = record.subarray(0, tab).toString('ascii').split(' ');
    const name = gitPath(record.subarray(tab + 1));
    const folded = name.toLocaleLowerCase('en-US');
    if (seen.has(folded)) throw new Error(`Case-insensitive path collision: ${name}`);
    seen.add(folded);
    if (mode !== '100644' && mode !== '100755') {
      const kind = mode === '120000' ? 'symlink' : mode === '160000' ? 'gitlink' : `mode ${mode}`;
      throw new Error(`Unsupported Git entry ${kind}: ${name}`);
    }
    if (type !== 'blob') throw new Error(`Unsupported Git object type ${type}: ${name}`);
    result.push({ path: name, mode, oid: oid(id) });
  }
  return result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function describeFiles(repo, list, write) {
  return list.map(({ path: file, mode, oid: blob }) => {
    const bytes = run(repo, ['cat-file', 'blob', blob], undefined, {}, true);
    write?.(file, mode, bytes);
    return { path: file, mode, digest: crypto.createHash('sha256').update(bytes).digest('hex') };
  });
}

function safeDestination(destination) {
  const abs = path.resolve(destination);
  if (abs === path.parse(abs).root) throw new Error('Destination cannot be a filesystem root');
  const parent = path.dirname(abs);
  fs.mkdirSync(parent, { recursive: true });
  const parentReal = fs.realpathSync(parent);
  if (fs.existsSync(abs)) {
    const stat = fs.lstatSync(abs);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(abs).length) {
      throw new Error(`Destination must not exist or must be an empty directory: ${abs}`);
    }
  }
  return { abs, parentReal };
}

function protectMetadata(repo, destination) {
  const gitDir = fs.realpathSync(run(repo, ['rev-parse', '--absolute-git-dir']).trim());
  let target = path.resolve(destination);
  const suffix = [];
  while (!fs.existsSync(target)) {
    suffix.unshift(path.basename(target));
    target = path.dirname(target);
  }
  target = path.join(fs.realpathSync(target), ...suffix);
  if (target === gitDir || target.startsWith(`${gitDir}${path.sep}`) || gitDir.startsWith(`${target}${path.sep}`)) {
    throw new Error('Destination overlaps Git metadata');
  }
}

function assertPortableSet(paths) {
  const seen = new Set();
  for (const value of paths) {
    const normalized = gitPath(value).toLocaleLowerCase('en-US');
    if (seen.has(normalized)) throw new Error(`Case-insensitive path collision: ${value}`);
    seen.add(normalized);
  }
}

function commitMessage(operation, receipt) {
  if (typeof operation !== 'string' || !operation.trim() || /[\r\n\0]/.test(operation)) throw new Error('Invalid operation');
  if (typeof receipt !== 'string' || !/^[0-9a-f]{64}$/.test(receipt)) throw new Error('Receipt must be a full SHA256 id');
  return `Verity promotion\n\nOperation: ${operation}\nReceipt: ${receipt}\n`;
}

export class GitRepo {
  #root;
  #objectFormat;

  constructor(root) {
    this.#root = canonicalRepo(root);
    this.#objectFormat = run(this.#root, ['rev-parse', '--show-object-format']).trim();
    if (!['sha1', 'sha256'].includes(this.#objectFormat)) throw new Error(`Unsupported Git object format: ${this.#objectFormat}`);
  }

  readRef(ref) {
    refName(ref);
    assertDirectRef(this.#root, ref);
    try { return run(this.#root, ['rev-parse', '--verify', '--quiet', `${ref}^{object}`]).trim(); }
    catch (error) {
      if (error.status === 1) return null;
      throw error;
    }
  }

  updateRef(ref, next, old, operation) {
    refName(ref);
    assertDirectRef(this.#root, ref);
    oid(next, 'new object id');
    const expected = old === null ? '0'.repeat(this.#objectFormat === 'sha1' ? 40 : 64) : oid(old, 'expected object id');
    const reason = operation === undefined ? [] : ['--create-reflog', '-m', `verity promote ${operation}`];
    if (operation !== undefined && (typeof operation !== 'string' || !operation.trim() || /[\r\n\0]/.test(operation))) {
      throw new Error('Invalid promotion operation ID');
    }
    run(this.#root, ['update-ref', '--no-deref', ...reason, ref, next, expected]);
  }

  changedPaths(base, candidate) {
    ensureCommit(this.#root, base);
    ensureCommit(this.#root, candidate);
    const raw = run(this.#root, ['diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', base, candidate, '--'], undefined, {}, true);
    const paths = nulRecords(raw).map(gitPath);
    return [...new Set(paths)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  }

  tree(commit) {
    ensureCommit(this.#root, commit);
    return run(this.#root, ['rev-parse', `${commit}^{tree}`]).trim();
  }

  integrationTree(head, candidate) {
    ensureCommit(this.#root, head);
    ensureCommit(this.#root, candidate);
    const output = run(this.#root, ['merge-tree', '--write-tree', head, candidate]).trim();
    return oid(output.split(/\s+/)[0], 'integration tree id');
  }

  manifest(commit) {
    return { tree: this.tree(commit), files: describeFiles(this.#root, entries(this.#root, commit)) };
  }

  materialize(commit, destination) {
    const list = entries(this.#root, commit);
    const paths = list.map((entry) => entry.path);
    assertPortableSet(paths);
    protectMetadata(this.#root, destination);
    const target = safeDestination(destination);
    const temp = fs.mkdtempSync(path.join(target.parentReal, '.verity-materialize-'));
    try {
      const files = describeFiles(this.#root, list, (name, mode, bytes) => {
        const file = path.join(temp, ...name.split('/'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes, { mode: mode === '100755' ? 0o755 : 0o644, flag: 'wx' });
      });
      const tree = this.tree(commit);
      if (fs.existsSync(target.abs)) fs.rmdirSync(target.abs);
      fs.renameSync(temp, target.abs);
      return { tree, files };
    } catch (error) {
      fs.rmSync(temp, { recursive: true, force: true });
      throw error;
    }
  }

  promotionCommit({ tree, parent, operation, receipt }) {
    oid(tree, 'tree id');
    ensureCommit(this.#root, parent);
    run(this.#root, ['cat-file', '-e', `${tree}^{tree}`]);
    const message = commitMessage(operation, receipt);
    return run(this.#root, ['-c', 'user.name=Verity', '-c', 'user.email=verity@invalid', 'commit-tree', tree, '-p', parent], Buffer.from(message)).trim();
  }

  fork(commit, destination) {
    ensureCommit(this.#root, commit);
    protectMetadata(this.#root, destination);
    const target = safeDestination(destination);
    const temp = fs.mkdtempSync(path.join(target.parentReal, '.verity-fork-'));
    try {
      this.materialize(commit, temp);
      run(temp, ['init', '--quiet', '--initial-branch=verity-candidate', `--object-format=${this.#objectFormat}`]);
      run(temp, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', this.#root, commit]);
      run(temp, ['update-ref', '--no-deref', 'HEAD', commit]);
      run(temp, ['read-tree', commit]);
      if (fs.existsSync(target.abs)) fs.rmdirSync(target.abs);
      fs.renameSync(temp, target.abs);
    } catch (error) {
      fs.rmSync(temp, { recursive: true, force: true });
      throw error;
    }
    const result = new GitRepo(target.abs);
    if (run(target.abs, ['remote']).trim()) {
      fs.rmSync(target.abs, { recursive: true, force: true });
      throw new Error('Fork unexpectedly has a remote');
    }
    return result;
  }

  capture(workspace, base) {
    ensureCommit(this.#root, base);
    const root = canonicalRepo(workspace);
    if (root === this.#root || root.startsWith(`${this.#root}${path.sep}`) || this.#root.startsWith(`${root}${path.sep}`)) {
      throw new Error('Capture workspace must be independent of the controller repository');
    }
    const files = [];
    const baseModes = new Map(entries(this.#root, base).map(({ path: file, mode }) => [file, mode]));
    const visit = (directory, prefix = '') => {
      for (const name of fs.readdirSync(directory)) {
        if (!prefix && name === '.git') continue;
        const rel = gitPath(prefix ? `${prefix}/${name}` : name);
        const abs = path.join(directory, name);
        const stat = fs.lstatSync(abs);
        if (stat.isDirectory()) visit(abs, rel);
        else if (stat.isFile()) {
          const mode = process.platform === 'win32' && baseModes.has(rel)
            ? baseModes.get(rel)
            : (stat.mode & 0o111) ? '100755' : '100644';
          files.push({ path: rel, mode, bytes: fs.readFileSync(abs) });
        }
        else throw new Error(`Unsupported workspace entry at ${rel}`);
      }
    };
    visit(root);
    assertPortableSet(files.map((file) => file.path));
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const rootNode = { files: [], dirs: new Map() };
    for (const file of files) {
      const segments = file.path.split('/');
      let node = rootNode;
      for (const segment of segments.slice(0, -1)) {
        if (!node.dirs.has(segment)) node.dirs.set(segment, { files: [], dirs: new Map() });
        node = node.dirs.get(segment);
      }
      const blob = run(this.#root, ['hash-object', '-w', '--stdin'], file.bytes).trim();
      node.files.push({ name: segments.at(-1), mode: file.mode, type: 'blob', oid: blob });
    }
    const writeTree = (node) => {
      const records = [
        ...node.files,
        ...[...node.dirs].map(([name, child]) => ({ name, mode: '040000', type: 'tree', oid: writeTree(child) })),
      ].map(({ name, mode, type, oid: object }) => `${mode} ${type} ${object}\t${name}\0`).join('');
      return run(this.#root, ['mktree', '-z'], Buffer.from(records)).trim();
    };
    const tree = writeTree(rootNode);
    const receipt = crypto.createHash('sha256').update(tree).digest('hex');
    const message = commitMessage('capture', receipt);
    return run(this.#root, ['-c', 'user.name=Verity', '-c', 'user.email=verity@invalid', 'commit-tree', tree, '-p', base], Buffer.from(message)).trim();
  }
}
