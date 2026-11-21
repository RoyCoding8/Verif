import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function git(cwd, ...args) {
  const input = args.at(-1)?.inputBuffer;
  if (input !== undefined) args.pop();
  const output = execFileSync('git', ['-C', cwd, ...args], {
    encoding: input === undefined ? 'utf8' : undefined, input, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(cwd, '.git', 'verity-empty-config') },
  });
  return Buffer.isBuffer(output) ? output : output.trim();
}

export function initRepo(root, objectFormat = 'sha1') {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '--quiet', '--initial-branch=main', `--object-format=${objectFormat}`);
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@invalid');
  return root;
}

export function commit(root, message) {
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}
